/** Reject recognizable credential material even inside otherwise safe tokens. */
export function hasIllustrationCredentialToken(value: string): boolean {
  return /(?:^|[^A-Za-z0-9])(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{30,})/u.test(value)
    || /(?:^|[^A-Za-z0-9])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/u.test(value);
}

export function hasIllustrationPrivateTokenPrefix(value: string): boolean {
  return /^(?:(?:sk|pk|rk|token|secret|bearer)(?:[-_]|$)|api[-_]key(?:[-_]|$))/iu.test(value);
}

/** One observed provider/model predicate shared by transport and metadata. */
export function isPublicIllustrationProviderToken(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= 128
    && value === value.normalize("NFC") && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
    && !hasIllustrationPrivateTokenPrefix(value) && !hasIllustrationCredentialToken(value);
}
