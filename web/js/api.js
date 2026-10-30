async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    let detail = '';
    try {
      const data = await response.json();
      detail = data.detail || '';
    } catch {
      detail = await response.text().catch(() => '');
    }
    throw new Error(detail || `Request failed (${response.status})`);
  }
  return response;
}

async function json(path, options) {
  return (await request(path, options)).json();
}

export const api = {
  getConfig: () => json('/api/config'),
  listPresets: () => json('/api/presets'),
  getPreset: (slug) => json(`/api/presets/${encodeURIComponent(slug)}`),
  savePreset: (preset, originalSlug = null, baseFromSlug = null) =>
    json('/api/presets', {
      method: 'POST',
      body: JSON.stringify({ preset, originalSlug, baseFromSlug }),
    }),
  deletePreset: (slug) =>
    json(`/api/presets/${encodeURIComponent(slug)}`, { method: 'DELETE' }),
  applyPreset: (slug) =>
    json(`/api/presets/${encodeURIComponent(slug)}/apply`, { method: 'POST' }),
  /** Turn a preset's stored original-image into a fresh upload for re-cropping. */
  restoreOriginal: (slug) =>
    json(`/api/presets/${encodeURIComponent(slug)}/original`, { method: 'POST' }),
  getOptions: () => json('/api/options'),
  saveOptions: (options) =>
    json('/api/options', { method: 'PUT', body: JSON.stringify(options) }),
  upload: (file) => {
    const form = new FormData();
    form.append('file', file);
    return json('/api/uploads', { method: 'POST', body: form });
  },
  /** Render a draft preset (optionally for a simulated `date`, `YYYY-MM-DD`). */
  renderDraft: async (preset, presetSlug = null, date = null) => {
    const response = await request('/api/render', {
      method: 'POST',
      body: JSON.stringify({ preset, presetSlug, ...(date ? { date } : {}) }),
    });
    return response.blob();
  },
  listWidgets: () => json('/api/widgets'),
  getWidget: (slug) => json(`/api/widgets/${encodeURIComponent(slug)}`),
  saveWidget: (widget, originalSlug = null) =>
    json('/api/widgets', {
      method: 'POST',
      body: JSON.stringify({ widget, originalSlug }),
    }),
  deleteWidget: (slug) =>
    json(`/api/widgets/${encodeURIComponent(slug)}`, { method: 'DELETE' }),
  renderWidget: async (widget) => {
    const response = await request('/api/widgets/render', {
      method: 'POST',
      body: JSON.stringify({ widget }),
    });
    return response.blob();
  },
  applyOutputUrl: (path) => path,
};
