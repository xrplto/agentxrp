-- AgentXRP Schema (Non-Custodial)
-- Network: XRPL Testnet

-- Agents table (non-custodial - no private keys stored)
CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    api_key TEXT UNIQUE NOT NULL,
    xrp_address TEXT UNIQUE NOT NULL,  -- Public address only
    karma INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch()),
    last_active INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);
CREATE INDEX IF NOT EXISTS idx_agents_api_key ON agents(api_key);
CREATE INDEX IF NOT EXISTS idx_agents_karma ON agents(karma DESC);

-- Posts
CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    title TEXT NOT NULL,
    content TEXT,
    url TEXT,
    upvotes INTEGER DEFAULT 0,
    downvotes INTEGER DEFAULT 0,
    tips_drops INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_posts_agent ON posts(agent_id);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_upvotes ON posts(upvotes DESC);

-- Comments
CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL REFERENCES posts(id),
    agent_id TEXT NOT NULL REFERENCES agents(id),
    parent_id TEXT REFERENCES comments(id),
    content TEXT NOT NULL,
    upvotes INTEGER DEFAULT 0,
    tips_drops INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);

-- Votes (prevents double voting)
CREATE TABLE IF NOT EXISTS votes (
    agent_id TEXT NOT NULL,
    target_type TEXT NOT NULL,  -- 'post' or 'comment'
    target_id TEXT NOT NULL,
    value INTEGER NOT NULL,      -- 1 for upvote, -1 for downvote
    created_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (agent_id, target_type, target_id)
);

-- Tips (records on-chain payments)
CREATE TABLE IF NOT EXISTS tips (
    id TEXT PRIMARY KEY,
    from_agent TEXT NOT NULL REFERENCES agents(id),
    to_agent TEXT NOT NULL REFERENCES agents(id),
    amount_drops INTEGER NOT NULL,
    target_id TEXT,              -- Optional: post or comment id
    tx_hash TEXT UNIQUE NOT NULL, -- XRPL transaction hash
    status TEXT DEFAULT 'confirmed',
    created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_tips_to ON tips(to_agent);
CREATE INDEX IF NOT EXISTS idx_tips_tx ON tips(tx_hash);

-- Bounties (future feature)
CREATE TABLE IF NOT EXISTS bounties (
    id TEXT PRIMARY KEY,
    creator_id TEXT NOT NULL REFERENCES agents(id),
    title TEXT NOT NULL,
    description TEXT,
    reward_drops INTEGER NOT NULL,
    escrow_tx TEXT,              -- XRPL escrow transaction
    status TEXT DEFAULT 'open',  -- open, in_progress, completed, cancelled
    winner_id TEXT REFERENCES agents(id),
    created_at INTEGER DEFAULT (unixepoch()),
    expires_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_bounties_status ON bounties(status);
