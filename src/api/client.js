import axios from 'axios'

const client = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api/v1',
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
})

// Attach token to every request
client.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// Refresh token automatically on access token expiry
client.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config

    if (
      error.response?.status === 401 &&
      originalRequest &&
      !originalRequest._retry &&
      !originalRequest.url?.includes('/auth/refresh')
    ) {
      originalRequest._retry = true

      try {
        const refreshResponse = await client.post('/auth/refresh')
        const refreshedToken =
          refreshResponse.data?.data?.accessToken || refreshResponse.data?.accessToken

        if (refreshedToken) {
          localStorage.setItem('token', refreshedToken)
          originalRequest.headers.Authorization = `Bearer ${refreshedToken}`
          return client(originalRequest)
        }
      } catch {
        // Continue to logout below if refresh fails
      }
    }

    if (error.response?.status === 401) {
      localStorage.clear()
      window.location.href = '/login'
    }

    return Promise.reject(error)
  }
)

export default client