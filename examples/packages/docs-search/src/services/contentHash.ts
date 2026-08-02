/**
 * Stable hash of what we embed — change detection without re-embedding.
 * Includes `model` so switching EMBEDDING_MODEL forces a full re-upsert
 * (vectors from different models are not comparable).
 */
export async function contentHash(
  page: { pageTitle: string; content: string },
  model: string,
): Promise<string> {
  const payload = `${model}\n${page.pageTitle}\n${page.content}`;
  const data = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
