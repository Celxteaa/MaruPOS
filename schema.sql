-- ============================================================
-- SKEMA SUPABASE UNTUK BACKEND VERIFIKASI LISENSI MARUPOS
-- Jalankan ini di Supabase Dashboard -> SQL Editor
-- ============================================================

create table if not exists public.licenses (
  license_key   text primary key,
  customer_name text,
  status        text not null default 'active' check (status in ('active','revoked','suspended')),
  max_devices   int  not null default 1,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now()
);

create table if not exists public.license_activations (
  id                bigint generated always as identity primary key,
  license_key       text not null references public.licenses(license_key) on delete cascade,
  device_id         text not null,
  activated_at      timestamptz not null default now(),
  last_verified_at  timestamptz not null default now(),
  unique (license_key, device_id)
);

create index if not exists idx_activations_license_key on public.license_activations(license_key);

-- Kunci akses: aktifkan RLS TANPA membuat policy apa pun.
-- Artinya tabel ini TIDAK BISA diakses oleh anon/authenticated key sama sekali,
-- hanya bisa diakses lewat service_role key yang dipakai Edge Function di server.
alter table public.licenses enable row level security;
alter table public.license_activations enable row level security;

-- ------------------------------------------------------------
-- Contoh: menambahkan satu lisensi baru untuk pelanggan
-- ------------------------------------------------------------
-- insert into public.licenses (license_key, customer_name, max_devices, expires_at)
-- values ('MARU-AB12-CD34-EF56', 'Toko Sinar Jaya', 1, now() + interval '365 days');
