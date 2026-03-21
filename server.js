const http = require("http");

// ── In-memory storage ──────────────────────────────────────────
const messages = [];
const online   = {};
let   nextId   = 1;

const MAX_MESSAGES = 500;
const OFFLINE_MS   = 90000;

// ── Profanity filter ───────────────────────────────────────────
const LEET_MAP = {
    "0":"o","1":"i","3":"e","4":"a","5":"s",
    "6":"g","7":"t","8":"b","@":"a","$":"s","!":"i"
};

function normalizeLeet(text) {
    return text.toLowerCase().replace(/[013456789@$!]/g, c => LEET_MAP[c] || c);
}

// Каждый паттерн ловит слово + повторы букв + символы между буквами
const BAD_PATTERNS = [
    // fuck, fuuck, fuckkk, fucked, fucking, fvck, fuk, phuck и т.д.
    /f+u+c+k+/i,
    /f[\s_\-.*]*u[\s_\-.*]*c[\s_\-.*]*k/i,
    /fv+ck/i,
    /fu+k+/i,
    /ph[\s_\-.*]*u[\s_\-.*]*c[\s_\-.*]*k/i,

    // shit, shiit, shitt, sh!t
    /s+h+i+t+/i,
    /s[\s_\-.*]*h[\s_\-.*]*i[\s_\-.*]*t/i,

    // bitch, biitch, b!tch
    /b+i+t+c+h+/i,
    /b[\s_\-.*]*i[\s_\-.*]*t[\s_\-.*]*c[\s_\-.*]*h/i,

    // asshole, ass
    /a+s+s+h+o+l+e+/i,
    /a[\s_\-.*]*s[\s_\-.*]*s[\s_\-.*]*h[\s_\-.*]*o[\s_\-.*]*l[\s_\-.*]*e/i,

    // cunt
    /c+u+n+t+/i,
    /c[\s_\-.*]*u[\s_\-.*]*n[\s_\-.*]*t/i,

    // dick, d!ck, diick
    /d+i+c+k+/i,
    /d[\s_\-.*]*i[\s_\-.*]*c[\s_\-.*]*k/i,

    // cock
    /c+o+c+k+/i,
    /c[\s_\-.*]*o[\s_\-.*]*c[\s_\-.*]*k/i,

    // pussy
    /p+u+s+s+y+/i,
    /p[\s_\-.*]*u[\s_\-.*]*s[\s_\-.*]*s[\s_\-.*]*y/i,

    // whore
    /w+h+o+r+e+/i,
    /wh[\s_\-.*]*o[\s_\-.*]*r[\s_\-.*]*e/i,

    // slut
    /s+l+u+t+/i,
    /s[\s_\-.*]*l[\s_\-.*]*u[\s_\-.*]*t/i,

    // bastard
    /b+a+s+t+a+r+d+/i,
    /b[\s_\-.*]*a[\s_\-.*]*s[\s_\-.*]*t[\s_\-.*]*a[\s_\-.*]*r[\s_\-.*]*d/i,

    // motherfucker
    /m+o+t+h+e+r+f+u+c+k+/i,

    // faggot, fag
    /f+a+g+o+t+/i,
    /f[\s_\-.*]*a[\s_\-.*]*g[\s_\-.*]*g[\s_\-.*]*o[\s_\-.*]*t/i,
    /\bfa+g+\b/i,

    // retard
    /r+e+t+a+r+d+/i,
    /r[\s_\-.*]*e[\s_\-.*]*t[\s_\-.*]*a[\s_\-.*]*r[\s_\-.*]*d/i,

    // nigger, nigga, niger, niga, nega — все варианты с разделителями
    /n[\s_\-.*]*i[\s_\-.*]*g[\s_\-.*]*g[\s_\-.*]*e[\s_\-.*]*r/i,
    /n[\s_\-.*]*i[\s_\-.*]*g[\s_\-.*]*g[\s_\-.*]*a/i,
    /n[\s_\-.*]*i[\s_\-.*]*g[\s_\-.*]*e[\s_\-.*]*r/i,
    /n[\s_\-.*]*i[\s_\-.*]*g[\s_\-.*]*a/i,
    /n[\s_\-.*]*e[\s_\-.*]*g[\s_\-.*]*a/i,
    /n[\s_\-.*]*e[\s_\-.*]*g[\s_\-.*]*e[\s_\-.*]*r/i,
    /nigg[a4@]+/i,
    /n[!1]+gg[ae3]+r?/i,

    // kys
    /\bk+y+s+\b/i,
];

function containsBadWord(text) {
    const lower  = text.toLowerCase();
    const normed = normalizeLeet(text);
    return BAD_PATTERNS.some(re => re.test(lower) || re.test(normed));
}

// ── Mute ───────────────────────────────────────────────────────
const muted = {};
const MUTE_DURATION = 60 * 60 * 1000; // 1 час

function isMuted(uid) {
    if (!muted[uid]) return false;
    if (Date.now() > muted[uid]) { delete muted[uid]; return false; }
    return true;
}

// ── Helpers ────────────────────────────────────────────────────
function json(res, code, data) {
    res.writeHead(code, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
    });
    res.end(JSON.stringify(data));
}

function pruneOffline(topic) {
    const now = Date.now();
    if (!online[topic]) return;
    for (const uid in online[topic])
        if (now - online[topic][uid].lastSeen > OFFLINE_MS)
            delete online[topic][uid];
}

function getOnlineList(topic) {
    pruneOffline(topic);
    const list = [];
    for (const uid in online[topic])
        list.push({ uid, ...online[topic][uid] });
    return list;
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
            try { resolve(JSON.parse(body)); }
            catch { reject(new Error("Invalid JSON")); }
        });
    });
}

// ── Router ─────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    const url    = new URL(req.url, "http://localhost");
    const path   = url.pathname;
    const method = req.method;

    if (method === "OPTIONS") { json(res, 200, {}); return; }

    // ── POST /send ─────────────────────────────────────────────
    if (method === "POST" && path === "/send") {
        let body;
        try { body = await readBody(req); }
        catch { json(res, 400, { error: "bad json" }); return; }

        const { topic, msgType, display, name, uid, toUid, text, time } = body;
        if (!topic || !uid) { json(res, 400, { error: "missing fields" }); return; }

        if (!online[topic]) online[topic] = {};
        online[topic][uid] = { display: display || uid, name: name || uid, lastSeen: Date.now() };

        if (msgType === "ping" || !text) { json(res, 200, { ok: true }); return; }

        if (isMuted(uid)) {
            const remaining = Math.ceil((muted[uid] - Date.now()) / 60000);
            json(res, 403, { error: "muted", minutesLeft: remaining });
            return;
        }

        if (containsBadWord(text)) {
            muted[uid] = Date.now() + MUTE_DURATION;
            json(res, 403, { error: "muted", minutesLeft: 60 });
            return;
        }

        const msg = {
            id: nextId++,
            topic,
            msgType: msgType || "public",
            display: display || uid,
            name:    name    || uid,
            uid,
            toUid:   toUid  || null,
            text,
            time:    time   || new Date().toISOString().substr(11, 5)
        };

        messages.push(msg);
        if (messages.length > MAX_MESSAGES) messages.shift();

        json(res, 200, { ok: true, id: msg.id });
        return;
    }

    // ── GET /messages ──────────────────────────────────────────
    if (method === "GET" && path === "/messages") {
        const topic   = url.searchParams.get("topic");
        const after   = parseInt(url.searchParams.get("after") || "0", 10);
        const myUid   = url.searchParams.get("uid") || "";
        const display = url.searchParams.get("display") || myUid;
        const name    = url.searchParams.get("name") || myUid;

        if (!topic) { json(res, 400, { error: "missing topic" }); return; }

        // Обновляем lastSeen — отдельный heartbeat не нужен
        if (myUid) {
            if (!online[topic]) online[topic] = {};
            online[topic][myUid] = { display, name, lastSeen: Date.now() };
        }

        const result = messages.filter(m => {
            if (m.topic !== topic || m.id <= after) return false;
            if (m.msgType === "public" || m.msgType === "join") return true;
            if (m.msgType === "private") return m.toUid === myUid || m.uid === myUid;
            return false;
        });

        json(res, 200, { messages: result, onlineList: getOnlineList(topic) });
        return;
    }

    // ── GET /online ────────────────────────────────────────────
    if (method === "GET" && path === "/online") {
        const topic = url.searchParams.get("topic");
        if (!topic) { json(res, 400, { error: "missing topic" }); return; }
        json(res, 200, { onlineList: getOnlineList(topic) });
        return;
    }

    // ── GET /ping ──────────────────────────────────────────────
    if (method === "GET" && path === "/ping") {
        const topic   = url.searchParams.get("topic");
        const uid     = url.searchParams.get("uid");
        const display = url.searchParams.get("display") || uid;
        const name    = url.searchParams.get("name")    || uid;
        if (topic && uid) {
            if (!online[topic]) online[topic] = {};
            online[topic][uid] = { display, name, lastSeen: Date.now() };
        }
        json(res, 200, { ok: true, onlineList: getOnlineList(topic) });
        return;
    }

    json(res, 404, { error: "not found" });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Chat relay running on port " + PORT));
