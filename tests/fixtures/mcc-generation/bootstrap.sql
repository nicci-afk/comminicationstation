set check_function_bodies=false;
-- Local test bootstrap. Exact fetched pgmq function bodies; synthetic tables only.
create role service_role;create role anon;create role authenticated;create schema pgmq;
create type pgmq.message_record as (msg_id bigint, read_ct integer, enqueued_at timestamp with time zone, vt timestamp with time zone, message jsonb, headers jsonb);
create table pgmq.q_sync_jobs(msg_id bigint generated always as identity primary key, read_ct int not null default 0, enqueued_at timestamptz not null default clock_timestamp(),vt timestamptz not null default clock_timestamp(),message jsonb,headers jsonb);
create table pgmq.q_triage_jobs(msg_id bigint generated always as identity primary key, read_ct int not null default 0, enqueued_at timestamptz not null default clock_timestamp(),vt timestamptz not null default clock_timestamp(),message jsonb,headers jsonb);
create table pgmq.q_pipeline_jobs(msg_id bigint generated always as identity primary key, read_ct int not null default 0, enqueued_at timestamptz not null default clock_timestamp(),vt timestamptz not null default clock_timestamp(),message jsonb,headers jsonb);
create table pgmq.q_digest_jobs(msg_id bigint generated always as identity primary key, read_ct int not null default 0, enqueued_at timestamptz not null default clock_timestamp(),vt timestamptz not null default clock_timestamp(),message jsonb,headers jsonb);
create table public.jobs_dead(id bigint generated always as identity primary key,queue text not null,msg_id bigint not null,message jsonb not null,error text not null,created_at timestamptz not null default clock_timestamp());
CREATE OR REPLACE FUNCTION pgmq.format_table_name(queue_name text, prefix text)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF queue_name ~ '\$|;|--|'''
    THEN
        RAISE EXCEPTION 'queue name contains invalid characters: $, ;, --, or \''';
    END IF;
    RETURN lower(prefix || '_' || queue_name);
END;
$function$;

CREATE OR REPLACE FUNCTION pgmq.read(queue_name text, vt integer, qty integer, conditional jsonb DEFAULT '{}'::jsonb)
 RETURNS SETOF pgmq.message_record
 LANGUAGE plpgsql
AS $function$
DECLARE
    sql TEXT;
    qtable TEXT := pgmq.format_table_name(queue_name, 'q');
BEGIN
    sql := FORMAT(
        $QUERY$
        WITH cte AS
        (
            SELECT msg_id
            FROM pgmq.%I
            WHERE vt <= clock_timestamp() AND CASE
                WHEN %L != '{}'::jsonb THEN (message @> %2$L)::integer
                ELSE 1
            END = 1
            ORDER BY msg_id ASC
            LIMIT $1
            FOR UPDATE SKIP LOCKED
        )
        UPDATE pgmq.%I m
        SET
            vt = clock_timestamp() + %L,
            read_ct = read_ct + 1
        FROM cte
        WHERE m.msg_id = cte.msg_id
        RETURNING m.msg_id, m.read_ct, m.enqueued_at, m.vt, m.message, m.headers;
        $QUERY$,
        qtable, conditional, qtable, make_interval(secs => vt)
    );
    RETURN QUERY EXECUTE sql USING qty;
END;
$function$;

CREATE OR REPLACE FUNCTION pgmq.delete(queue_name text, msg_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
    sql TEXT;
    result BIGINT;
    qtable TEXT := pgmq.format_table_name(queue_name, 'q');
BEGIN
    sql := FORMAT(
        $QUERY$
        DELETE FROM pgmq.%I
        WHERE msg_id = $1
        RETURNING msg_id
        $QUERY$,
        qtable
    );
    EXECUTE sql USING msg_id INTO result;
    RETURN NOT (result IS NULL);
END;
$function$;

CREATE OR REPLACE FUNCTION pgmq.delete(queue_name text, msg_ids bigint[])
 RETURNS SETOF bigint
 LANGUAGE plpgsql
AS $function$
DECLARE
    sql TEXT;
    qtable TEXT := pgmq.format_table_name(queue_name, 'q');
BEGIN
    sql := FORMAT(
        $QUERY$
        DELETE FROM pgmq.%I
        WHERE msg_id = ANY($1)
        RETURNING msg_id
        $QUERY$,
        qtable
    );
    RETURN QUERY EXECUTE sql USING msg_ids;
END;
$function$;

CREATE OR REPLACE FUNCTION pgmq.send(queue_name text, msg jsonb, headers jsonb, delay timestamp with time zone)
 RETURNS SETOF bigint
 LANGUAGE plpgsql
AS $function$
DECLARE
    sql TEXT;
    qtable TEXT := pgmq.format_table_name(queue_name, 'q');
BEGIN
    sql := FORMAT(
            $QUERY$
        INSERT INTO pgmq.%I (vt, message, headers)
        VALUES ($2, $1, $3)
        RETURNING msg_id;
        $QUERY$,
            qtable
           );
    RETURN QUERY EXECUTE sql USING msg, delay, headers;
END;
$function$;

CREATE OR REPLACE FUNCTION pgmq.send(queue_name text, msg jsonb)
 RETURNS SETOF bigint
 LANGUAGE sql
AS $function$
    SELECT * FROM pgmq.send(queue_name, msg, NULL, clock_timestamp());
$function$;

CREATE OR REPLACE FUNCTION pgmq.send(queue_name text, msg jsonb, headers jsonb)
 RETURNS SETOF bigint
 LANGUAGE sql
AS $function$
    SELECT * FROM pgmq.send(queue_name, msg, headers, clock_timestamp());
$function$;

CREATE OR REPLACE FUNCTION pgmq.send(queue_name text, msg jsonb, delay integer)
 RETURNS SETOF bigint
 LANGUAGE sql
AS $function$
    SELECT * FROM pgmq.send(queue_name, msg, NULL, clock_timestamp() + make_interval(secs => delay));
$function$;

CREATE OR REPLACE FUNCTION pgmq.send(queue_name text, msg jsonb, delay timestamp with time zone)
 RETURNS SETOF bigint
 LANGUAGE sql
AS $function$
    SELECT * FROM pgmq.send(queue_name, msg, NULL, delay);
$function$;

CREATE OR REPLACE FUNCTION pgmq.send(queue_name text, msg jsonb, headers jsonb, delay integer)
 RETURNS SETOF bigint
 LANGUAGE sql
AS $function$
    SELECT * FROM pgmq.send(queue_name, msg, headers, clock_timestamp() + make_interval(secs => delay));
$function$;

CREATE OR REPLACE FUNCTION public.claim_jobs(p_queue text, p_n integer, p_vt integer)
 RETURNS TABLE(msg_id bigint, read_ct integer, message jsonb)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select m.msg_id, m.read_ct, m.message
  from pgmq.read(p_queue, p_vt, p_n) m;
$function$;

revoke all on function public.claim_jobs(text,int,int) from public,anon,authenticated;grant execute on function public.claim_jobs(text,int,int) to service_role;
CREATE OR REPLACE FUNCTION public.ack_job(p_queue text, p_msg_id bigint)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select pgmq.delete(p_queue, p_msg_id);
$function$;

revoke all on function public.ack_job(text,bigint) from public,anon,authenticated;grant execute on function public.ack_job(text,bigint) to service_role;
CREATE OR REPLACE FUNCTION public.dead_letter_job(p_queue text, p_msg_id bigint, p_message jsonb, p_error text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.jobs_dead (queue, msg_id, message, error)
  values (p_queue, p_msg_id, p_message, p_error);
  perform pgmq.delete(p_queue, p_msg_id);
end;
$function$;

revoke all on function public.dead_letter_job(text,bigint,jsonb,text) from public,anon,authenticated;grant execute on function public.dead_letter_job(text,bigint,jsonb,text) to service_role;
set check_function_bodies=true;
