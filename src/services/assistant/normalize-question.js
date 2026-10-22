/** Fix common owner typos before routing (interpret + refine). */
export function normalizeAssistantQuestion(text) {
  let q = String(text ?? "").trim();
  if (!q) return q;

  const rules = [
    [/\bcolaction\b/gi, "collection"],
    [/\bcollaction\b/gi, "collection"],
    [/\bcollectoin\b/gi, "collection"],
    [/\bcollction\b/gi, "collection"],
    [/\bcolletion\b/gi, "collection"],
    [/\bcolletions\b/gi, "collections"],
    [/\bcolllection\b/gi, "collection"],
    [/\bcollecion\b/gi, "collection"],
    [/\bbext\b/gi, "best"],
    [/\blast two monts\b/gi, "last two month"],
    [/\blast two onth\b/gi, "last two month"],
    [/\blast 2 onth\b/gi, "last 2 month"],
    [/\btwo onth\b/gi, "two month"],
    [/\b2 onth\b/gi, "2 month"],
    [/\bonth\b/gi, "month"],
    [/\benth\b/gi, "month"],
    [/\bmnth\b/gi, "month"],
    [/\bshworoom\b/gi, "showroom"],
    [/\bdefaulters\b/gi, "defaulters"],
    [/\benrol+\b/gi, "enrol"],
  ];

  for (const [pattern, replacement] of rules) {
    q = q.replace(pattern, replacement);
  }
  return q.replace(/\s+/g, " ").trim();
}
