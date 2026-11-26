-- ==============================================================================
-- Migration: Phase 3 Next-Gen Work - GitHub Storage, Machine Tokens & Live Chat
-- File: docs/work/03_work_github_chat.sql
-- Idempotent: Safe to execute repeatedly in Supabase / PostgreSQL SQL Editor
-- ==============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Table: work_machines (Machine-bound Work Tokens)
CREATE TABLE IF NOT EXISTS public.work_machines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    machine_id TEXT NOT NULL,
    machine_name TEXT NOT NULL DEFAULT 'Workstation',
    machine_token TEXT NOT NULL UNIQUE DEFAULT ('WK-' || upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 4)) || '-' || upper(substr(encode(gen_random_bytes(6), 'hex'), 5, 4))),
    github_username TEXT NULL,
    github_token TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_work_machines_user_machine UNIQUE (user_id, machine_id)
);

ALTER TABLE public.work_machines ADD COLUMN IF NOT EXISTS github_token TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_work_machines_token ON public.work_machines (machine_token);
CREATE INDEX IF NOT EXISTS idx_work_machines_user_id ON public.work_machines (user_id);

-- 2. Table: work_tools (Tools stored on GitHub, indexed by Machine Token)
CREATE TABLE IF NOT EXISTS public.work_tools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    machine_token TEXT NOT NULL REFERENCES public.work_machines(machine_token) ON DELETE CASCADE,
    owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL,
    notes TEXT NULL,
    github_owner TEXT NOT NULL,
    github_repo TEXT NOT NULL DEFAULT 'dsh-work-vault',
    github_release_tag TEXT NOT NULL,
    github_asset_id BIGINT NOT NULL,
    github_asset_name TEXT NOT NULL,
    file_size BIGINT NOT NULL DEFAULT 0,
    sha256 TEXT NOT NULL,
    has_git_bundle BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_work_tools_machine_token ON public.work_tools (machine_token);
CREATE INDEX IF NOT EXISTS idx_work_tools_owner_id ON public.work_tools (owner_id);

-- 3. Table: work_messages (Live 1-1 Chat between Machine Tokens)
CREATE TABLE IF NOT EXISTS public.work_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_token TEXT NOT NULL,
    receiver_token TEXT NOT NULL,
    sender_name TEXT NULL,
    content TEXT NOT NULL,
    is_edited BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_work_messages_pair ON public.work_messages (sender_token, receiver_token, created_at);
CREATE INDEX IF NOT EXISTS idx_work_messages_receiver ON public.work_messages (receiver_token, created_at);

-- 4. Enable RLS
ALTER TABLE public.work_machines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_messages ENABLE ROW LEVEL SECURITY;

-- Permissions & Grants
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.work_machines TO authenticated;
-- REVOKE broad SELECT on work_machines from anon to prevent dumping GitHub tokens
REVOKE ALL ON public.work_machines FROM anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.work_tools TO authenticated;
GRANT SELECT ON public.work_tools TO anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.work_messages TO anon, authenticated;

-- Policies for work_machines (Strict User Isolation: Each user can ONLY access their own machine records)
DROP POLICY IF EXISTS "work_machines_public_lookup" ON public.work_machines;
DROP POLICY IF EXISTS "work_machines_user_all" ON public.work_machines;
CREATE POLICY "work_machines_user_all"
    ON public.work_machines
    FOR ALL
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Secure Public View: Exposes machine public profile WITHOUT leaking github_token
CREATE OR REPLACE VIEW public.work_machines_public AS
SELECT
    id,
    user_id,
    machine_id,
    machine_name,
    machine_token,
    github_username,
    created_at,
    updated_at
FROM public.work_machines;

GRANT SELECT ON public.work_machines_public TO anon, authenticated;

-- Policies for work_tools
DROP POLICY IF EXISTS "work_tools_owner_all" ON public.work_tools;
CREATE POLICY "work_tools_owner_all"
    ON public.work_tools
    FOR ALL
    TO authenticated
    USING (auth.uid() = owner_id)
    WITH CHECK (auth.uid() = owner_id);

DROP POLICY IF EXISTS "work_tools_token_select" ON public.work_tools;
CREATE POLICY "work_tools_token_select"
    ON public.work_tools
    FOR SELECT
    TO anon, authenticated
    USING (true);

-- Policies for work_messages
DROP POLICY IF EXISTS "work_messages_participant_select" ON public.work_messages;
CREATE POLICY "work_messages_participant_select"
    ON public.work_messages
    FOR SELECT
    TO anon, authenticated
    USING (true);

DROP POLICY IF EXISTS "work_messages_insert" ON public.work_messages;
CREATE POLICY "work_messages_insert"
    ON public.work_messages
    FOR INSERT
    TO anon, authenticated
    WITH CHECK (true);

DROP POLICY IF EXISTS "work_messages_update" ON public.work_messages;
CREATE POLICY "work_messages_update"
    ON public.work_messages
    FOR UPDATE
    TO anon, authenticated
    USING (true);

DROP POLICY IF EXISTS "work_messages_delete" ON public.work_messages;
CREATE POLICY "work_messages_delete"
    ON public.work_messages
    FOR DELETE
    TO anon, authenticated
    USING (true);

-- 5. Stored Procedures / RPC Functions

-- Register or retrieve machine record
CREATE OR REPLACE FUNCTION public.register_or_get_machine(
    p_machine_id TEXT,
    p_machine_name TEXT DEFAULT 'Workstation',
    p_github_username TEXT DEFAULT NULL,
    p_github_token TEXT DEFAULT NULL
)
RETURNS TABLE (
    id UUID,
    machine_id TEXT,
    machine_name TEXT,
    machine_token TEXT,
    github_username TEXT,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_user_id UUID;
    v_record public.work_machines%ROWTYPE;
    v_gen_token TEXT;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required to register machine';
    END IF;

    -- Look up existing machine
    SELECT * INTO v_record
    FROM public.work_machines
    WHERE user_id = v_user_id AND work_machines.machine_id = p_machine_id;

    IF v_record.id IS NOT NULL THEN
        -- Update machine info if changed
        UPDATE public.work_machines
        SET machine_name = COALESCE(p_machine_name, v_record.machine_name),
            github_username = COALESCE(p_github_username, v_record.github_username),
            github_token = COALESCE(p_github_token, v_record.github_token),
            updated_at = timezone('utc'::text, now())
        WHERE id = v_record.id
        RETURNING * INTO v_record;
    ELSE
        -- Generate unique machine token: WK-XXXX-XXXX
        v_gen_token := 'WK-' || upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 4)) || '-' || upper(substr(encode(gen_random_bytes(6), 'hex'), 5, 4));

        INSERT INTO public.work_machines (user_id, machine_id, machine_name, machine_token, github_username, github_token)
        VALUES (v_user_id, p_machine_id, COALESCE(p_machine_name, 'Workstation'), v_gen_token, p_github_username, p_github_token)
        RETURNING * INTO v_record;
    END IF;

    RETURN QUERY
    SELECT v_record.id, v_record.machine_id, v_record.machine_name, v_record.machine_token, v_record.github_username, v_record.created_at;
END;
$$;

-- Secure proxy helper: returns GitHub download credentials only to users holding the valid machine_token
CREATE OR REPLACE FUNCTION public.get_tool_download_auth(p_token TEXT)
RETURNS TABLE (
    github_owner TEXT,
    github_repo TEXT,
    github_token TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT
        m.github_username,
        'dsh-work-vault'::TEXT,
        m.github_token
    FROM public.work_machines m
    WHERE m.machine_token = p_token
    LIMIT 1;
END;
$$;

-- Query tools by Machine Token
CREATE OR REPLACE FUNCTION public.get_tools_by_token(p_token TEXT)
RETURNS TABLE (
    id UUID,
    tool_name TEXT,
    notes TEXT,
    github_owner TEXT,
    github_repo TEXT,
    github_release_tag TEXT,
    github_asset_id BIGINT,
    github_asset_name TEXT,
    file_size BIGINT,
    sha256 TEXT,
    has_git_bundle BOOLEAN,
    created_at TIMESTAMPTZ,
    machine_name TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT
        t.id,
        t.tool_name,
        t.notes,
        t.github_owner,
        t.github_repo,
        t.github_release_tag,
        t.github_asset_id,
        t.github_asset_name,
        t.file_size,
        t.sha256,
        t.has_git_bundle,
        t.created_at,
        m.machine_name
    FROM public.work_tools t
    JOIN public.work_machines m ON m.machine_token = t.machine_token
    WHERE t.machine_token = p_token
    ORDER BY t.created_at DESC;
END;
$$;

-- Send message
CREATE OR REPLACE FUNCTION public.send_work_message(
    p_sender_token TEXT,
    p_receiver_token TEXT,
    p_sender_name TEXT,
    p_content TEXT
)
RETURNS TABLE (
    id UUID,
    sender_token TEXT,
    receiver_token TEXT,
    sender_name TEXT,
    content TEXT,
    is_edited BOOLEAN,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_msg public.work_messages%ROWTYPE;
BEGIN
    IF trim(p_content) = '' THEN
        RAISE EXCEPTION 'Message content cannot be empty';
    END IF;

    INSERT INTO public.work_messages (sender_token, receiver_token, sender_name, content)
    VALUES (p_sender_token, p_receiver_token, p_sender_name, p_content)
    RETURNING * INTO v_msg;

    RETURN QUERY
    SELECT v_msg.id, v_msg.sender_token, v_msg.receiver_token, v_msg.sender_name, v_msg.content, v_msg.is_edited, v_msg.created_at;
END;
$$;

-- Edit message
CREATE OR REPLACE FUNCTION public.edit_work_message(
    p_message_id UUID,
    p_sender_token TEXT,
    p_new_content TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE public.work_messages
    SET content = p_new_content,
        is_edited = true,
        updated_at = timezone('utc'::text, now())
    WHERE id = p_message_id AND sender_token = p_sender_token;

    RETURN FOUND;
END;
$$;

-- Delete message
CREATE OR REPLACE FUNCTION public.delete_work_message(
    p_message_id UUID,
    p_sender_token TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    DELETE FROM public.work_messages
    WHERE id = p_message_id AND sender_token = p_sender_token;

    RETURN FOUND;
END;
$$;

-- Clear conversation between 2 tokens
CREATE OR REPLACE FUNCTION public.clear_work_chat_history(
    p_token1 TEXT,
    p_token2 TEXT
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_deleted INT;
BEGIN
    DELETE FROM public.work_messages
    WHERE (sender_token = p_token1 AND receiver_token = p_token2)
       OR (sender_token = p_token2 AND receiver_token = p_token1);
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

-- 6. Enable Supabase Realtime publication
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'work_messages'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.work_messages;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'work_tools'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.work_tools;
    END IF;
EXCEPTION
    WHEN OTHERS THEN
        -- Safely ignore if publication is managed externally
        NULL;
END;
$$;
