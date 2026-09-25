create extension if not exists "uuid-ossp";

create type public.user_role as enum (
  'student',
  'admin'
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,

  role public.user_role not null default 'student',

  display_name text,

  created_at timestamptz not null default now()
);

create table public.quizzes (
  id uuid primary key default uuid_generate_v4(),

  owner_id uuid references auth.users(id) on delete set null,

  title text not null,

  source_label text,

  language text not null default 'Hinglish',

  question_count integer not null,

  questions jsonb not null,

  is_public boolean not null default false,

  created_at timestamptz not null default now()
);

create table public.attempts (
  id uuid primary key default uuid_generate_v4(),

  quiz_id uuid references public.quizzes(id) on delete cascade,

  user_id uuid references auth.users(id) on delete cascade,

  score integer not null default 0,

  total integer not null,

  answers jsonb not null default '[]'::jsonb,

  created_at timestamz not null default now()
);

create index quizzes_owner_id_index
on public.quizzes(owner_id);

create index attempts_user_id_index
on public.attempts(user_id);

create index attempts_quiz_id_index
on public.attempts(quiz_id);

alter table public.profiles enable row level security;

alter table public.quizzes enable row level security;

alter table public.attempts enable row level security;

create policy "Student can see own profile"
on public.profiles
for select
using (
  auth.uid() = id
);

create policy "Student can update own profile"
on public.profiles
for update
using (
  auth.uid() = id
)
with check (
  auth.uid() = id
);

create policy "Student can see own quizzes"
on public.quizzes
for select
using (
  owner_id = auth.uid()
  or is_public = true
);

create policy "Student can see own attempts"
on public.attempts
for select
using (
  user_id = auth.uid()
);

create policy "Student can create own attempts"
on public.attempts
for insert
with check (
  user_id = auth.uid()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'display_name',
      split_part(
        coalesce(new.email, new.phone, 'Student'),
        '@',
        1
      )
    )
  );

  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row
execute procedure public.handle_new_user();
