/**
 * Deterministic, read-only trigger dry-run scoring.
 * Zero third-party dependencies; one linear pass over the visible skills.
 */

function tokenise(text) {
  const tokens = new Set();
  const source = String(text ?? '').toLowerCase();
  for (const chunk of source.split(/[^\p{L}\p{N}]+/u)) {
    if (!chunk) continue;
    if (/[\u3400-\u9fff]/u.test(chunk)) {
      tokens.add(chunk);
      for (let i = 0; i + 2 <= chunk.length; i += 1) tokens.add(chunk.slice(i, i + 2));
    } else {
      tokens.add(chunk);
    }
  }
  return tokens;
}

const NAME_WEIGHT = 2;

export function scoreSkills(description, skills = []) {
  const wanted = tokenise(description);
  const scored = [];
  for (const current of skills) {
    const skill = current ?? {};
    const nameTokens = tokenise(skill.name);
    const bodyTokens = tokenise(`${skill.description ?? ''} ${skill.whenToUse ?? ''}`);
    const allTokens = new Set([...nameTokens, ...bodyTokens]);
    const matchedTerms = [];
    let weight = 0;
    for (const token of wanted) {
      if (nameTokens.has(token)) {
        matchedTerms.push(token);
        weight += NAME_WEIGHT;
      } else if (bodyTokens.has(token)) {
        matchedTerms.push(token);
        weight += 1;
      }
    }
    matchedTerms.sort();
    const denominator = Math.sqrt(allTokens.size || 1);
    const score = Math.min(1, weight / denominator);
    const excluded = skill.invocation?.userInvocable === false ? 'not_user_invocable' : undefined;
    scored.push({
      skill: {
        name: skill.name ?? '',
        description: skill.description ?? '',
        whenToUse: skill.whenToUse ?? '',
        source: skill.source ?? '',
        provider: skill.provider ?? '',
        path: skill.path ?? '',
        invocation: skill.invocation ?? {},
      },
      score,
      matchedTerms,
      ...(excluded ? { excluded } : {}),
    });
  }
  scored.sort((a, b) =>
    b.score - a.score ||
    a.skill.name.localeCompare(b.skill.name) ||
    (a.skill.provider ?? '').localeCompare(b.skill.provider ?? '')
  );
  return scored;
}
