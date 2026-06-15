export type { OAuthToken, TokenStore, AuthStatus } from './types.js'
export { OAuthError } from './types.js'

export type { AuthFileData } from './token-store.js'
export {
  PLUGINS_KEY,
  loadAuthFile,
  saveAuthFile,
  extractTokenStore,
  mergeTokenStore,
} from './token-store.js'

export {
  isTokenValid,
  isTokenExpired,
  classifyStatus,
  refreshAccessToken,
  fetchClientCredentialsToken,
  exchangeAuthorizationCode,
  TokenManager,
} from './token-manager.js'
export type { TokenPersistence } from './token-manager.js'
