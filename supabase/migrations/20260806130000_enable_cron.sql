-- Enable the extensions the cleanup schedule needs.
-- pg_cron  → provides the cron schema + cron.schedule() job runner
-- pg_net   → provides net.http_post() so the cron job can call the edge function
create extension if not exists pg_cron;
create extension if not exists pg_net;
