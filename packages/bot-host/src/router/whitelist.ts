import { config } from "../config.js";

/**
 * Membership lookup against the env-configured allow lists.
 * Empty list = allow all (no restriction).
 */
export function isAllowed(chat_id: string, user_id: string): boolean {
  return isChatAllowed(chat_id) && isUserAllowed(user_id);
}

export function isChatAllowed(chat_id: string): boolean {
  return config.ALLOWED_CHAT_IDS.length === 0 || config.ALLOWED_CHAT_IDS.includes(chat_id);
}

export function isUserAllowed(user_id: string): boolean {
  return config.ALLOWED_USER_IDS.length === 0 || config.ALLOWED_USER_IDS.includes(user_id);
}
