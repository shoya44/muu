// 書き込み API の認可。共有パスワードひとつを Bearer で受け、Secret と定数時間比較する。
// ブラウザからの越境要求は Sec-Fetch-Site で拒む。ヘッダを送らない非ブラウザ（curl、テスト）は通す。

export function sameOrigin(request) {
  const site = request.headers.get('sec-fetch-site');
  return !site || site === 'same-origin' || site === 'none';
}

export function bearer(request) {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : '';
}

export function constantTimeEqual(a, b) {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

export function authorize(request, secret) {
  if (!secret) return { ok: false, status: 503, error: 'password_not_configured' };
  if (!sameOrigin(request)) return { ok: false, status: 403, error: 'cross_site' };
  const token = bearer(request);
  if (!token || !constantTimeEqual(token, secret)) return { ok: false, status: 401, error: 'unauthorized' };
  return { ok: true };
}
