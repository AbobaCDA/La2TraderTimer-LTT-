-- Per-account character archive. Archiving is non-destructive to the character record,
-- but the application clears any active timer before setting hidden=true.

alter table public.characters
  add column if not exists hidden boolean not null default false;
