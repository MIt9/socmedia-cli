// YouTube channel guard shared by the extension and the CLI.
// Pure functions, no I/O.
(function (g: any) {
  const CHANNEL_ID_RE = /^UC[\w-]{22}$/;
  const norm = (s: unknown) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

  function studioUrl(id: string): string {
    if (!CHANNEL_ID_RE.test(id)) throw new Error(`Bad channel id: ${id}`);
    return `https://studio.youtube.com/channel/${id}`;
  }

  function studioChannelId(url: unknown): string | null {
    const m = /^https:\/\/studio\.youtube\.com\/channel\/(UC[\w-]{22})(?:[/?#]|$)/.exec(String(url || ""));
    return m ? m[1]! : null;
  }

  function judgeProbe(probe: any, exp: { id: string; label?: string; handle?: string | null }, { need = "studio" } = {}) {
    const reasons: string[] = [];
    const p = probe || {};
    let ok = false;
    if (p.studioChannelId) {
      if (p.studioChannelId === exp.id) {
        if (need === "studio") ok = true;
      } else {
        reasons.push(`Studio URL is channel ${p.studioChannelId}, expected ${exp.id}`);
      }
    } else if (need === "studio") {
      reasons.push("active tab is not studio.youtube.com/channel/<id>");
    }

    const a = p.account;
    if (a && (a.channelId || a.handle || a.name)) {
      let hit = false;
      if (a.channelId) hit = a.channelId === exp.id;
      else if (a.handle && exp.handle) hit = norm(a.handle).replace(/^@/, "") === norm(exp.handle).replace(/^@/, "");
      else if (exp.label) hit = !!norm(a.name) && norm(a.name).includes(norm(exp.label));
      if (hit) {
        if (need === "account") ok = true;
      } else {
        reasons.push(`active account is "${a.name || a.handle || a.channelId}", expected ${exp.label || exp.id} (${exp.id})`);
      }
    } else if (need === "account") {
      reasons.push("cannot read the active account from the account menu");
    }

    return { matched: ok && reasons.length === 0, reasons };
  }

  const api = { CHANNEL_ID_RE, studioUrl, studioChannelId, judgeProbe };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else g.ytJudge = api;
})(typeof self !== "undefined" ? self : globalThis);
