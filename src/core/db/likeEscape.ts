/**
 * Escapes SQL LIKE metacharacters (`%`, `_`, and the escape character
 * itself, `\`) in a user-supplied search fragment, so it's matched as a
 * literal substring instead of a wildcard pattern. Every caller that
 * builds a `LIKE ?` pattern from free-text input (a search query, or any
 * text reflected back into a pattern) must pair this with `ESCAPE '\'` in
 * the SQL — without it, a literal `_` in the fragment matches any single
 * character and a literal `%` matches any run of characters, silently
 * returning wrong/over-broad results with no error or indication to the
 * caller (e.g. searching memory for "wifi_password" would also match an
 * unrelated "wifi.password" row, since `_` means "any one character").
 */
export function escapeLikeFragment(fragment: string): string {
  return fragment.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}
