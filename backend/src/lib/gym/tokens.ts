/**
 * Random identifiers used in links: the share id of the printable day
 * protocol and the access token of the mobile views. Both are unguessable and
 * URL-safe; the alphabet avoids characters that are ambiguous when read aloud.
 */
import { customAlphabet } from "nanoid";

const alphabet = "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ";

export const newShareId = customAlphabet(alphabet, 14);
export const newAccessToken = customAlphabet(alphabet, 32);

/** How long a mobile link stays valid. */
export const ACCESS_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
