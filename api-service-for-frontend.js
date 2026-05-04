// src/services/api.js
// Drop this file into your React frontend src/services/ folder
// It replaces all localStorage calls with real API calls

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000/api'

// ── Helpers ──────────────────────────────────────────────────────

function getToken() {
  return localStorage.getItem('hb_token')
}

async function request(path, options = {}) {
  const token = getToken()
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options.headers,
  }

  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers })
  const data = await res.json()

  if (!res.ok) {
    const msg = data?.error || `Request failed: ${res.status}`
    throw new Error(msg)
  }
  return data
}

// ── Auth ─────────────────────────────────────────────────────────

export const authApi = {
  register: (body) => request('/auth/register', { method: 'POST', body: JSON.stringify(body) }),
  login:    (body) => request('/auth/login',    { method: 'POST', body: JSON.stringify(body) }),
  me:       ()     => request('/auth/me'),
  update:   (body) => request('/auth/me',       { method: 'PATCH', body: JSON.stringify(body) }),
}

// ── Campaigns ─────────────────────────────────────────────────────

export const campaignApi = {
  getAll:  (params = {}) => {
    const qs = new URLSearchParams(params).toString()
    return request(`/campaigns${qs ? `?${qs}` : ''}`)
  },
  getOne:  (id)  => request(`/campaigns/${id}`),
  getMy:   ()    => request('/campaigns/my'),
  create:  (formData) => {
    // formData is a FormData object (supports file upload)
    const token = getToken()
    return fetch(`${BASE_URL}/campaigns`, {
      method:  'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body:    formData,
    }).then(r => r.json())
  },
  update:  (id, formData) => {
    const token = getToken()
    return fetch(`${BASE_URL}/campaigns/${id}`, {
      method:  'PATCH',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body:    formData,
    }).then(r => r.json())
  },
  delete:  (id) => request(`/campaigns/${id}`, { method: 'DELETE' }),
}

// ── Donations ─────────────────────────────────────────────────────

export const donationApi = {
  create:         (body) => request('/donations', { method: 'POST', body: JSON.stringify(body) }),
  getCampaignDons:(id)   => request(`/donations/campaign/${id}`),
}

// ── Admin ─────────────────────────────────────────────────────────

export const adminApi = {
  getStats:         ()      => request('/admin/stats'),
  getUsers:         ()      => request('/admin/users'),
  toggleUser:       (id)    => request(`/admin/users/${id}/toggle`, { method: 'PATCH' }),
  getCampaigns:     (params)=> {
    const qs = new URLSearchParams(params || {}).toString()
    return request(`/admin/campaigns${qs ? `?${qs}` : ''}`)
  },
  updateCampaign:   (id, body) => request(`/admin/campaigns/${id}/status`, { method: 'PATCH', body: JSON.stringify(body) }),
  getDonations:     ()      => request('/admin/donations'),
  getDisputes:      ()      => request('/admin/disputes'),
  createDispute:    (body)  => request('/admin/disputes', { method: 'POST', body: JSON.stringify(body) }),
  resolveDispute:   (id)    => request(`/admin/disputes/${id}/resolve`, { method: 'PATCH' }),
}

// ── Token helpers ─────────────────────────────────────────────────

export function saveToken(token) { localStorage.setItem('hb_token', token) }
export function clearToken()    { localStorage.removeItem('hb_token') }
