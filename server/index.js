import "dotenv/config";

import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import pdf from "pdf-parse";
import { createClient } from "@supabase/supabase-js";

const app = express();

const PORT = process.env.PORT || 10000;
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 20);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "";

const supabaseAdmin = createClient(
  SUPABASE_URL || "https://placeholder.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY || "placeholder"
);

app.use(cors());

app.use(
  express.json({
    limit: "2mb"
  })
);

app.use(
  "/api",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: "Too many requests. Please wait for 15 minutes and try again."
    }
  })
);

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: MAX_UPLOAD_MB * 1024 * 1024
  },

  fileFilter: (_request, file, callback) => {
    const allowedMimeTypes = [
      "application/pdf",
      "text/plain",
      "text/markdown"
    ];

    const allowedExtension = /.(pdf|txt|md)$/i.test(file.originalname);

    if (allowedMimeTypes.includes(file.mimetype) || allowedExtension) {
      callback(null, true);
      return;
    }

    callback(
      new Error("Only PDF, TXT and MD files are allowed.")
    );
  }
});

function cleanText(value, maxLength = 120000) {
  return String(value || "")
    .trim()
    .slice(0, maxLength);
}

function isSafePublicUrl(value) {
  try {
    const url = new URL(value);

    const isHttp =
      url.protocol === "https:" || url.protocol === "http:";

    const unsafeHost =
      url.hostname === "localhost" ||
      url.hostname.startsWith("127.") ||
      url.hostname.startsWith("0.") ||
      url.hostname.startsWith("169.254.");

    return isHttp && !unsafeHost;
  } catch {
    return false;
  }
}

function removeHtml(text) {
  return String(text || "")
    .replace(/<script[sS]*?</script>/gi, " ")
    .replace(/<style[sS]*?</style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/s+/g, " ")
    .trim();
}

async function extractTextFromPublicUrl(sourceUrl) {
  if (!isSafePublicUrl(sourceUrl)) {
    throw new Error(
      "Please provide a valid public http(s) PDF or notes link."
    );
  }

  const response = await fetch(sourceUrl, {
    signal: AbortSignal.timeout(15000),
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(
      "This public link could not be read. Please upload a file or try another link."
    );
  }

  const contentLength = Number(
    response.headers.get("content-length") || 0
  );

  if (contentLength > MAX_UPLOAD_MB * 1024 * 1024) {
    throw new Error(
      `The linked file is larger than ${MAX_UPLOAD_MB} MB.`
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length > MAX_UPLOAD_MB * 1024 * 1024) {
    throw new Error(
      `The linked file is larger than ${MAX_UPLOAD_MB} MB.`
    );
  }

  const contentType = response.headers.get("content-type") || "";
  const isPdf =
    contentType.includes("application/pdf") ||
    sourceUrl.toLowerCase().includes(".pdf");

  if (isPdf) {
    const parsedPdf = await pdf(buffer);
    return parsedPdf.text;
  }

  return removeHtml(buffer.toString("utf8"));
}

async function getUserFromToken(request) {
  const authorization = request.headers.authorization || "";

  if (!authorization.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.replace("Bearer ", "").trim();

  if (!token) {
    return null;
  }

  const {
    data: { user }
  } = await supabaseAdmin.auth.getUser(token);

  return user || null;
}

function parseQuizJson(text) {
  const clean = String(text || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const firstBrace = clean.indexOf("{");
  const lastBrace = clean.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error(
      "AI returned an invalid quiz response. Please try again."
    );
  }

  const jsonText = clean.slice(firstBrace, lastBrace + 1);

  return JSON.parse(jsonText);
}

function validateQuiz(quiz, requestedCount) {
  if (!quiz || !Array.isArray(quiz.questions)) {
    throw new Error("Quiz questions were not generated correctly.");
  }

  const questions = quiz.questions
    .slice(0, requestedCount)
    .map((question, index) => {
      const type = [
        "mcq",
        "true_false",
        "fill_blank"
      ].includes(question.type)
        ? question.type
        : "mcq";

      const options = Array.isArray(question.options)
        ? question.options
        : [];

      return {
        id: question.id || `q-${index + 1}`,
        type,
        question: cleanText(question.question, 1000),
        options: options.map((option) => cleanText(option, 300)),
        answer: cleanText(question.answer, 500),
        explanation: cleanText(question.explanation, 1500)
      };
    })
    .filter(
      (question) =>
        question.question &&
        question.answer &&
        question.explanation
    );

  if (questions.length === 0) {
    throw new Error("No valid questions could be generated.");
  }

  return {
    title: cleanText(quiz.title || "MyBTEUP Quiz", 200),
    questions
  };
}

async function generateQuizWithGemini({
  subject,
  topic,
  bookName,
  material,
  count,
  language,
  kind
}) {
  if (!GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY is not configured in Render environment variables."
    );
  }

  const topicLabel = [subject, topic, bookName]
    .filter(Boolean)
    .join(" — ");

  const sourceInstruction = material
    ? `
Use the following provided study material as the PRIMARY source.
Do not create facts that are absent from the study material.

STUDY MATERIAL:
${material}
`
    : `
The user did not provide notes or a PDF.

Create a syllabus-style educational quiz only about this topic:
${topicLabel}

Use reliable general academic knowledge. Do not invent exact dates,
laws, formulas, numerical values, author quotes, or factual claims
when uncertain.
`;

  const prompt = `
You are an accurate educational quiz generator for MyBTEUP Quiz.

Generate exactly ${count} quiz questions.

Language: ${language}
Requested question type: ${kind}

Allowed types:
- mcq
- true_false
- fill_blank

Rules:
- If type is mcq, provide exactly 4 options.
- If type is true_false, provide options exactly ["True", "False"].
- If type is fill_blank, options must be [].
- Each question must have one clear correct answer.
- Explain every answer simply in ${language}.
- Do not include markdown formatting.
- Keep explanations short and student-friendly.
- Use a mixture of easy, medium, and difficult questions when type is mixed.

${sourceInstruction}

Return ONLY valid JSON in exactly this format:

{
  "title": "Quiz title",
  "questions": [
    {
      "id": "q1",
      "type": "mcq",
      "question": "Question text",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "answer": "Correct option text",
      "explanation": "Short explanation"
    }
  ]
}
`;

  const geminiResponse = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
      encodeURIComponent(GEMINI_API_KEY),
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: prompt
              }
            ]
          }
        ],

        generationConfig: {
          temperature: 0.35,
          responseMimeType: "application/json"
        }
      })
    }
  );

  const geminiData = await geminiResponse.json();

  if (!geminiResponse.ok) {
    throw new Error(
      geminiData?.error?.message ||
        "Gemini API could not generate the quiz."
    );
  }

  const generatedText =
    geminiData?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("") || "";

  const parsedQuiz = parseQuizJson(generatedText);

  return validateQuiz(parsedQuiz, count);
}

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    app: "MyBTEUP Quiz"
  });
});

app.get("/api/config", (_request, response) => {
  response.json({
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    ADMIN_EMAIL
  });
});

app.post(
  "/api/quizzes/generate",
  upload.single("file"),
  async (request, response) => {
    try {
      const user = await getUserFromToken(request);

      const subject = cleanText(request.body.subject, 300);
      const topic = cleanText(request.body.topic, 300);
      const bookName = cleanText(request.body.bookName, 300);
      const sourceUrl = cleanText(request.body.sourceUrl, 2000);
      const language = ["Hindi", "English", "Hinglish"].includes(
        request.body.language
      )
        ? request.body.language
        : "Hinglish";

      const kind = [
        "mixed",
        "mcq",
        "true_false",
        "fill_blank"
      ].includes(request.body.kind)
        ? request.body.kind
        : "mixed";

      const count = Math.min(
        Math.max(Number(request.body.count) || 25, 1),
        50
      );

      let material = cleanText(request.body.text);

      if (request.file) {
        const isPdf =
          request.file.mimetype.includes("pdf") ||
          request.file.originalname.toLowerCase().endsWith(".pdf");

        material = isPdf
          ? (await pdf(request.file.buffer)).text
          : request.file.buffer.toString("utf8");
      } else if (sourceUrl) {
        material = await extractTextFromPublicUrl(sourceUrl);
      }

      if (!material && !subject && !topic && !bookName) {
        throw new Error(
          "Please provide a subject, topic, book name, text, PDF, notes, or a public link."
        );
      }

      const quiz = await generateQuizWithGemini({
        subject,
        topic,
        bookName,
        material,
        count,
        language,
        kind
      });

      let databaseQuizId = null;

      if (user) {
        const { data, error } = await supabaseAdmin
          .from("quizzes")
          .insert({
            owner_id: user.id,
            title: quiz.title,
            source_label: [subject, topic, bookName]
              .filter(Boolean)
              .join(" • "),
            language,
            question_count: quiz.questions.length,
            questions: quiz.questions
          })
          .select()
          .single();

        if (!error && data) {
          databaseQuizId = data.id;
        }
      }

      response.json({
        ...quiz,
        dbId: databaseQuizId
      });
    } catch (error) {
      console.error("Quiz generation error:", error);

      response.status(400).json({
        error: error.message || "Quiz could not be generated."
      });
    }
  }
);

app.use(
  express.static(
    new URL("../../client/dist", import.meta.url).pathname
  )
);

app.get(/.*/, (_request, response) => {
  response.sendFile(
    new URL("../../client/dist/index.html", import.meta.url).pathname
  );
});

app.use((error, _request, response, _next) => {
  console.error("Server error:", error);

  response.status(400).json({
    error: error.message || "Request failed."
  });
});

app.listen(PORT, () => {
  console.log(`MyBTEUP Quiz is running on port ${PORT}`);
});
