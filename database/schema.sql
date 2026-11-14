-- CV Analysis: database schema (PostgreSQL / Supabase).
-- Run this once in the Supabase SQL editor on a new project.
-- The evaluation tables live in eval/eval_cases.sql.

create table jobs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  title text not null,
  requirements text not null
);

create table candidates (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  job_id uuid not null references jobs(id) on delete cascade,
  full_name text not null,
  email text not null,
  phone text not null,
  current_title text,
  years_experience numeric,
  university text,
  degree text,
  graduation_year int,
  skills text,
  cv_text text,
  cv_path text,
  constraint candidates_job_email_unique unique (job_id, email)
);

create table screenings (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  job_id uuid not null references jobs(id) on delete cascade,
  candidate_id uuid not null references candidates(id) on delete cascade,
  status text not null check (status in ('Accepted', 'Rejected')),
  score int check (score between 0 and 100),
  reason text,
  unique (job_id, candidate_id)
);

create table workflow_errors (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  workflow_name text,
  node_name text,
  message text,
  execution_url text
);

-- Only the n8n backend (service role key) can read or write.
alter table jobs enable row level security;
alter table candidates enable row level security;
alter table screenings enable row level security;
alter table workflow_errors enable row level security;

-- Private bucket for the uploaded CV files.
insert into storage.buckets (id, name, public) values ('cvs', 'cvs', false);
