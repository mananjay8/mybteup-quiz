import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@supabase/supabase-js";
import "./styles.css";

const config = {};
let supabase = null;

async function api(path, options = {}) {
  let token = null;

  if (supabase) {
    const {
      data: { session }
    } = await supabase.auth.getSession();

    token = session?.access_token || null;
  }

  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Something went wrong.");
  }

  return data;
}

function normalizeAnswer(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function Header({ user, setUser, setPage }) {
  const isAdmin =
    user &&
    config.ADMIN_EMAIL &&
    user.email?.toLowerCase() === config.ADMIN_EMAIL.toLowerCase();

  async function logout() {
    if (supabase) {
      await supabase.auth.signOut();
    }

    setUser(null);
    setPage("home");
  }

  return (
    <header className="header">
      <button className="brand" onClick={() => setPage("home")}>
        <span className="brand-icon">📘</span>
        <span>MyBTEUP Quiz</span>
      </button>

      <nav className="nav">
        <button onClick={() => setPage("generate")}>Create Quiz</button>

        {user && (
          <button onClick={() => setPage("dashboard")}>
            My Dashboard
          </button>
        )}

        {isAdmin && (
          <button onClick={() => setPage("admin")}>
            Admin Panel
          </button>
        )}

        {!user ? (
          <button className="primary-button" onClick={() => setPage("auth")}>
            Login / Sign Up
          </button>
        ) : (
          <button onClick={logout}>Logout</button>
        )}
      </nav>
    </header>
  );
}

function HomePage({ setPage }) {
  return (
    <main>
      <section className="hero">
        <p className="eyebrow">STUDY • PRACTICE • IMPROVE</p>

        <h1>
          Learn smarter with
          <span> MyBTEUP Quiz</span>
        </h1>

        <p className="hero-description">
          Create quizzes from your subject, topic, book name, notes, PDF,
          study material, or public link. Get instant correct/wrong feedback
          with simple explanations.
        </p>

        <div className="hero-buttons">
          <button
            className="primary-button large-button"
            onClick={() => setPage("generate")}
          >
            Start Quiz as Guest
          </button>

          <button
            className="secondary-button large-button"
            onClick={() => setPage("auth")}
          >
            Login to Save Progress
          </button>
        </div>
      </section>

      <section className="feature-grid">
        <article className="feature-card">
          <div className="feature-icon">⚡</div>
          <h3>Instant Feedback</h3>
          <p>
            Every answer ke baad turant correct/wrong result aur explanation.
          </p>
        </article>

        <article className="feature-card">
          <div className="feature-icon">📄</div>
          <h3>Use Your Material</h3>
          <p>
            PDF, notes, topic, book name, pasted text aur public link se quiz.
          </p>
        </article>

        <article className="feature-card">
          <div className="feature-icon">🔒</div>
          <h3>Private Scores</h3>
          <p>
            Score public nahi hoga. Sirf student aur admin access kar sakte hain.
          </p>
        </article>
      </section>
    </main>
  );
}

function AuthPage({ setUser, setPage }) {
  const [mode, setMode] = useState("login");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();

    setMessage("");
    setLoading(true);

    try {
      if (!supabase) {
        throw new Error(
          "Supabase configuration is missing. Please add Render environment variables."
        );
      }

      const isEmail = identifier.includes("@");

      if (mode === "signup") {
        const result = isEmail
          ? await supabase.auth.signUp({
              email: identifier.
