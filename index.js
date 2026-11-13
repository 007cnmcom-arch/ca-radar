
import axios from "axios";
import fs from "node:fs";
import "dotenv/config";

const {
  TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID,
  X_BEARER_TOKEN
} = process.env;

const STATE_FILE = "./radar-state.json";
const WINDOW_MS = 30 * 60 * 1000;
const ALERT_THRESHOLD = 5;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { projects: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function extractCA(text) {
  const results = [];

  const bsc = text.match(/\b0x[a-fA-F0-9]{40}\b/g) || [];
  for (const address of bsc) {
    results.push({ chain: "BSC", address });
  }

  const sol = text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g) || [];
  for (const address of sol) {
    results.push({ chain: "Solana", address });
  }

  return [...new Map(
    results.map(x => [`${x.chain}:${x.address}`, x])
  ).values()];
}

async function sendTelegram(message) {
  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      disable_web_page_preview: true
    }
  );
}

async function main() {
  const response = await axios.get(
    "https://api.x.com/2/tweets/search/recent",
    {
      headers: {
        Authorization: `Bearer ${X_BEARER_TOKEN}`
      },
      params: {
        query: "(CA OR contract OR token OR pump) -is:retweet",
        max_results: 100,
        "tweet.fields": "created_at,author_id",
        expansions: "author_id",
        "user.fields": "username"
      },
      timeout: 30000
    }
  );

  const tweets = response.data.data || [];
  const users = response.data.includes?.users || [];
  const usernames = new Map(
    users.map(u => [u.id, u.username])
  );

  const state = loadState();
  const now = Date.now();

  for (const tweet of tweets) {
    const created = new Date(tweet.created_at).getTime();
    if (!created || now - created > WINDOW_MS) continue;

    for (const item of extractCA(tweet.text)) {
      const key = `${item.chain}:${item.address}`;

      if (!state.projects[key]) {
        state.projects[key] = {
          chain: item.chain,
          address: item.address,
          tweets: [],
          lastAlert: 0
        };
      }

      const project = state.projects[key];

      if (project.tweets.some(t => t.id === tweet.id)) continue;

      project.tweets.push({
        id: tweet.id,
        author: tweet.author_id,
        username: usernames.get(tweet.author_id) || tweet.author_id,
        time: tweet.created_at,
        url: `https://x.com/i/web/status/${tweet.id}`
      });
    }
  }

  for (const project of Object.values(state.projects)) {
    project.tweets = project.tweets.filter(t =>
      now - new Date(t.time).getTime() <= WINDOW_MS
    );

    const accounts = new Map();
    for (const tweet of project.tweets) {
      if (!accounts.has(tweet.author)) {
        accounts.set(tweet.author, tweet);
      }
    }

    if (
      accounts.size >= ALERT_THRESHOLD &&
      now - project.lastAlert >= WINDOW_MS
    ) {
      const sources = [...accounts.values()];

      const details = sources.slice(0, 10).map((t, i) =>
        `${i + 1}. @${t.username}\n${t.url}\n${t.time}`
      ).join("\n\n");

      await sendTelegram(
        `🚨 CA 雷达报警\n\n` +
        `链：${project.chain}\n` +
        `CA：${project.address}\n` +
        `30分钟不同账号：${accounts.size}\n\n` +
        `来源推文：\n${details}`
      );

      project.lastAlert = now;
    }
  }

  saveState(state);
  console.log(`扫描完成：读取 ${tweets.length} 条推文`);
}

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID || !X_BEARER_TOKEN) {
  throw new Error("缺少必要的环境变量");
}

main().catch(error => {
  console.error(error.response?.data || error.message);
  process.exitCode = 1;
});
