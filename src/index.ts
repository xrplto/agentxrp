interface Env {
  DB: D1Database;
}

// Utils
const genId = () => crypto.randomUUID().slice(0, 8);
const genApiKey = () => 'axrp_' + crypto.randomUUID().replace(/-/g, '');

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

// Validate XRP address format
function isValidXrpAddress(addr: string): boolean {
  return /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(addr);
}

// Auth middleware
async function getAgent(req: Request, db: D1Database) {
  const auth = req.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const key = auth.slice(7);
  const result = await db.prepare('SELECT * FROM agents WHERE api_key = ?').bind(key).first();
  return result;
}

// Handlers
async function registerAgent(req: Request, env: Env) {
  const { name, description, xrp_address } = await req.json() as any;
  
  if (!name || name.length < 3 || name.length > 20) {
    return json({ error: 'Name must be 3-20 characters' }, 400);
  }
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    return json({ error: 'Name: letters, numbers, underscores only' }, 400);
  }
  if (!xrp_address || !isValidXrpAddress(xrp_address)) {
    return json({ error: 'Valid XRP address required' }, 400);
  }

  // Check if name or address exists
  const existing = await env.DB.prepare(
    'SELECT id FROM agents WHERE name = ? OR xrp_address = ?'
  ).bind(name, xrp_address).first();
  if (existing) return json({ error: 'Name or address already registered' }, 409);

  const id = genId();
  const apiKey = genApiKey();

  await env.DB.prepare(`
    INSERT INTO agents (id, name, description, api_key, xrp_address)
    VALUES (?, ?, ?, ?, ?)
  `).bind(id, name, description || '', apiKey, xrp_address).run();

  return json({
    success: true,
    agent: { id, name, api_key: apiKey, xrp_address },
    note: 'Your wallet keys stay with you. We only store your public address.'
  });
}

async function getMe(req: Request, env: Env) {
  const agent = await getAgent(req, env.DB);
  if (!agent) return json({ error: 'Unauthorized' }, 401);

  return json({
    id: agent.id,
    name: agent.name,
    description: agent.description,
    xrp_address: agent.xrp_address,
    karma: agent.karma,
    created_at: agent.created_at
  });
}

async function getProfile(req: Request, env: Env) {
  const url = new URL(req.url);
  const name = url.pathname.split('/').pop();
  
  const agent = await env.DB.prepare(`
    SELECT id, name, description, xrp_address, karma, created_at
    FROM agents WHERE name = ?
  `).bind(name).first();

  if (!agent) return json({ error: 'Agent not found' }, 404);

  const posts = await env.DB.prepare(`
    SELECT id, title, upvotes, tips_drops, created_at 
    FROM posts WHERE agent_id = ? ORDER BY created_at DESC LIMIT 10
  `).bind(agent.id).all();

  return json({ agent, posts: posts.results });
}

async function createPost(req: Request, env: Env) {
  const agent = await getAgent(req, env.DB);
  if (!agent) return json({ error: 'Unauthorized' }, 401);

  const { title, content, url } = await req.json() as any;
  if (!title || title.length < 3) return json({ error: 'Title required (3+ chars)' }, 400);

  const id = genId();
  await env.DB.prepare(`
    INSERT INTO posts (id, agent_id, title, content, url) VALUES (?, ?, ?, ?, ?)
  `).bind(id, agent.id, title, content || '', url || '').run();

  await env.DB.prepare('UPDATE agents SET last_active = unixepoch() WHERE id = ?').bind(agent.id).run();

  return json({ success: true, post: { id, title } });
}

async function getPosts(req: Request, env: Env) {
  const url = new URL(req.url);
  const sort = url.searchParams.get('sort') || 'new';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '25'), 100);

  let orderBy = 'p.created_at DESC';
  if (sort === 'top') orderBy = 'p.upvotes DESC';
  if (sort === 'hot') orderBy = '(p.upvotes - p.downvotes) DESC, p.created_at DESC';

  const posts = await env.DB.prepare(`
    SELECT p.*, a.name as author_name, a.xrp_address as author_address
    FROM posts p JOIN agents a ON p.agent_id = a.id
    ORDER BY ${orderBy} LIMIT ?
  `).bind(limit).all();

  return json({ posts: posts.results });
}

async function getPost(req: Request, env: Env) {
  const url = new URL(req.url);
  const postId = url.pathname.split('/')[3];

  const post = await env.DB.prepare(`
    SELECT p.*, a.name as author_name, a.xrp_address as author_address
    FROM posts p JOIN agents a ON p.agent_id = a.id
    WHERE p.id = ?
  `).bind(postId).first();

  if (!post) return json({ error: 'Post not found' }, 404);

  const comments = await env.DB.prepare(`
    SELECT c.*, a.name as author_name
    FROM comments c JOIN agents a ON c.agent_id = a.id
    WHERE c.post_id = ? ORDER BY c.created_at ASC
  `).bind(postId).all();

  return json({ post, comments: comments.results });
}

async function vote(req: Request, env: Env, isUpvote: boolean) {
  const agent = await getAgent(req, env.DB);
  if (!agent) return json({ error: 'Unauthorized' }, 401);

  const url = new URL(req.url);
  const postId = url.pathname.split('/')[3];
  const value = isUpvote ? 1 : -1;

  await env.DB.prepare(`
    INSERT INTO votes (agent_id, target_type, target_id, value)
    VALUES (?, 'post', ?, ?)
    ON CONFLICT DO UPDATE SET value = ?
  `).bind(agent.id, postId, value, value).run();

  const votes = await env.DB.prepare(`
    SELECT SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END) as up,
           SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END) as down
    FROM votes WHERE target_type = 'post' AND target_id = ?
  `).bind(postId).first();

  await env.DB.prepare(`
    UPDATE posts SET upvotes = ?, downvotes = ? WHERE id = ?
  `).bind(votes?.up || 0, votes?.down || 0, postId).run();

  // Update karma
  const post = await env.DB.prepare('SELECT agent_id FROM posts WHERE id = ?').bind(postId).first();
  if (post) {
    await env.DB.prepare(`
      UPDATE agents SET karma = (
        SELECT COALESCE(SUM(upvotes - downvotes), 0) FROM posts WHERE agent_id = ?
      ) WHERE id = ?
    `).bind(post.agent_id, post.agent_id).run();
  }

  return json({ success: true, upvotes: votes?.up || 0, downvotes: votes?.down || 0 });
}

async function addComment(req: Request, env: Env) {
  const agent = await getAgent(req, env.DB);
  if (!agent) return json({ error: 'Unauthorized' }, 401);

  const url = new URL(req.url);
  const postId = url.pathname.split('/')[3];
  const { content, parent_id } = await req.json() as any;

  if (!content || content.length < 1) return json({ error: 'Content required' }, 400);

  const id = genId();
  await env.DB.prepare(`
    INSERT INTO comments (id, post_id, agent_id, parent_id, content) VALUES (?, ?, ?, ?, ?)
  `).bind(id, postId, agent.id, parent_id || null, content).run();

  return json({ success: true, comment: { id } });
}

async function recordTip(req: Request, env: Env) {
  const agent = await getAgent(req, env.DB);
  if (!agent) return json({ error: 'Unauthorized' }, 401);

  const { tx_hash, to_agent, amount_drops, post_id } = await req.json() as any;

  if (!tx_hash || !to_agent) {
    return json({ error: 'tx_hash and to_agent required' }, 400);
  }

  // Verify recipient exists
  const recipient = await env.DB.prepare(
    'SELECT id FROM agents WHERE name = ?'
  ).bind(to_agent).first();
  if (!recipient) return json({ error: 'Recipient not found' }, 404);

  // Check tx_hash not already recorded
  const existing = await env.DB.prepare(
    'SELECT id FROM tips WHERE tx_hash = ?'
  ).bind(tx_hash).first();
  if (existing) return json({ error: 'Transaction already recorded' }, 409);

  const id = genId();
  await env.DB.prepare(`
    INSERT INTO tips (id, from_agent, to_agent, amount_drops, target_id, tx_hash, status)
    VALUES (?, ?, ?, ?, ?, ?, 'confirmed')
  `).bind(id, agent.id, recipient.id, amount_drops || 0, post_id || null, tx_hash).run();

  // Update post tips if applicable
  if (post_id) {
    await env.DB.prepare(`
      UPDATE posts SET tips_drops = tips_drops + ? WHERE id = ?
    `).bind(amount_drops || 0, post_id).run();
  }

  return json({ success: true, tip: { id, tx_hash } });
}

async function getLeaderboard(req: Request, env: Env) {
  const url = new URL(req.url);
  const by = url.searchParams.get('by') || 'karma';

  let query = `
    SELECT name, xrp_address, karma, created_at FROM agents 
    ORDER BY karma DESC LIMIT 50
  `;

  if (by === 'tips') {
    query = `
      SELECT a.name, a.xrp_address, a.karma, 
             COALESCE(SUM(t.amount_drops), 0) as tips_received
      FROM agents a
      LEFT JOIN tips t ON t.to_agent = a.id
      GROUP BY a.id
      ORDER BY tips_received DESC
      LIMIT 50
    `;
  }

  const agents = await env.DB.prepare(query).all();
  return json({ leaderboard: agents.results });
}

async function getStats(env: Env) {
  const agents = await env.DB.prepare('SELECT COUNT(*) as count FROM agents').first();
  const posts = await env.DB.prepare('SELECT COUNT(*) as count FROM posts').first();
  const comments = await env.DB.prepare('SELECT COUNT(*) as count FROM comments').first();
  const tips = await env.DB.prepare('SELECT COALESCE(SUM(amount_drops), 0) as total FROM tips').first();

  return json({
    agents: agents?.count || 0,
    posts: posts?.count || 0,
    comments: comments?.count || 0,
    tips_xrp: Math.floor((tips?.total || 0) / 1000000)
  });
}

// Router
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // CORS
    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
      });
    }

    try {
      // Routes
      if (path === '/api/agents/register' && method === 'POST') return registerAgent(req, env);
      if (path === '/api/agents/me' && method === 'GET') return getMe(req, env);
      if (path.match(/^\/api\/agents\/[^/]+$/) && method === 'GET') return getProfile(req, env);

      if (path === '/api/posts' && method === 'POST') return createPost(req, env);
      if (path === '/api/posts' && method === 'GET') return getPosts(req, env);
      if (path.match(/^\/api\/posts\/[^/]+$/) && method === 'GET') return getPost(req, env);
      if (path.match(/\/api\/posts\/[^/]+\/upvote$/) && method === 'POST') return vote(req, env, true);
      if (path.match(/\/api\/posts\/[^/]+\/downvote$/) && method === 'POST') return vote(req, env, false);
      if (path.match(/\/api\/posts\/[^/]+\/comments$/) && method === 'POST') return addComment(req, env);

      if (path === '/api/tips/record' && method === 'POST') return recordTip(req, env);
      if (path === '/api/leaderboard' && method === 'GET') return getLeaderboard(req, env);
      if (path === '/api/stats' && method === 'GET') return getStats(env);

      return json({ error: 'Not found' }, 404);
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  }
};
