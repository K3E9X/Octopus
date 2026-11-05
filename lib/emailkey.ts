// The one spelling two forms of the same mailbox both reduce to.
//
// It exists in its own module because two very different places need it and neither
// should drag the other in: attribution, which has to decide whether a breached row is
// about the subject, and REGISTRATION, which has to decide whether an address is a new
// customer or the same one coming back for another free trial.
//
// `victim@gmail.com`, `victim+1@gmail.com`, `vic.tim@gmail.com` and `VICTIM+2@Gmail.com`
// are one inbox. Treating them as four accounts handed four trials to one person, in
// about a tenth of a second, scripted, each one spending the operator's own upstream
// balance.
//
// Two rules, and they are not the same rule:
//
//   A `+tag` is a tag everywhere. Gmail, Outlook, Fastmail, Proton and most corporate
//   mail all deliver `user+anything@domain` to `user@domain`.
//
//   A DOT is only insignificant at Google. Elsewhere `vic.tim@` and `victim@` can be
//   two different people, and collapsing them would merge two real customers into one
//   account, a worse failure than the one this prevents.

const DOTLESS_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

export function canonicalEmail(addr: string): string {
  const lower = String(addr ?? "").trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at <= 0) return lower;
  const domain = lower.slice(at + 1);
  let local = lower.slice(0, at);
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (DOTLESS_DOMAINS.has(domain)) local = local.replace(/\./g, "");
  return local ? local + "@" + domain : lower;
}
