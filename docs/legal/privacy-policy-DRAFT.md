# STRYX PRIVACY POLICY

> **DRAFT, not yet published.** Written from what Stryx collects and does today (October 2026). It is not
> legal advice. Before it goes live: a lawyer in your jurisdiction must review it and complete every
> `[BRACKETED]` item, and every statement of fact in it must be checked again against the product (see
> `privacy-policy-REVIEW.md`). Delete this note when the text is final.

**Version:** 1.0\
**Effective Date:** October 3, 2026\
**Last Updated:** October 3, 2026\
**Operator:** Stryx ("Stryx", "we", "us", or "our")\
**Contact:** [CONTACT EMAIL]

This Privacy Policy explains what personal information Stryx collects, why, who it is shared with, how
long it is kept, and the choices you have. It applies to the Stryx website, dashboard, APIs and related
services (the "Service") and forms part of our Terms of Use. Terms that are capitalised here have the
meaning given in the Terms of Use.

## 1. The short version

- We collect the least we need to run the Service: the wallet address you sign in with, the wallets
  you create or import, the transactions you ask us to send, and a security record of what happened.
  If you join the waitlist we keep your email address.
- Private keys of Stryx wallets are stored encrypted. Keys of wallets you connect never reach us.
- We do not sell your personal information, and we do not use it for advertising.
- We do not currently use advertising trackers or third-party analytics on our website or app.
- Blockchains are public. Anything written to one (an address, a transaction) is visible to everyone and
  we cannot delete it.
- You can ask to see, correct or delete your information. Section 9 says how.

## 2. Information we collect

### 2.1 Information you give us

- **Waitlist.** The email address you enter. If you are later invited, we may note that on your entry.
- **Your account.** Your wallet address and, when you sign in, a signature that proves you control it.
  Optionally a display name and your Discord and X handles. These are shown only to you and to Stryx
  administrators. We do not look the handles up on Discord or X.
- **Invite code.** The code you use. We keep only a one-way fingerprint of it, not the code itself, along
  with whatever note the administrator who made it wrote (for example who it was for) and whether and
  when it was used.
- **Stryx wallets.** For a wallet you create or import: its address, a label you choose, its status, how
  it came to Stryx (created or imported), and its private key in encrypted form (section 4).
- **Instructions and settings.** Mints, transfers, Disperse distributions and schedules you set up, the
  recipient and vault addresses you enter, spending limits and emergency-stop settings.
- **Messages to us.** If you contact us, what you send and how to reply.

### 2.2 Information created as you use the Service

- **Transaction and mint records.** For each attempt: which wallet, which network and contract, the
  quantity, the outcome and any short failure reason, the transaction hash, fees and mint price, and
  timestamps. A record of the NFTs minted by your Stryx wallets and where they were later sent.
- **Security log.** A record of important actions: sign-ins and sign-outs, wallet creation, key exports
  and rotations, mints, transfers, emergency stops, invite-code use, and administrator actions. Each entry
  records who did what, to which wallet, when, and whether it worked. It does not contain IP addresses.
- **Session information.** When you sign in we create a session. Only a one-way fingerprint of the session
  token is stored on our side.
- **Acceptance records.** When you accept the Terms of Use and this Policy we record which version, when,
  and technical evidence of the acceptance (a one-way fingerprint of your IP address and your browser's
  user-agent text).

### 2.3 Technical information

- **IP addresses.** To limit abuse (for example repeated sign-in or waitlist attempts) we count requests
  per IP address. These counters are held in memory and expire within about an hour. Our hosting and
  network providers, and any server that sits in front of the Service, may also keep standard technical
  logs (such as IP address, device and browser type, and the pages or API calls requested) for security
  and reliability. [Complete this section once the hosting set-up is final.]
- **Cookies and similar storage** are described in section 6.

### 2.4 Information from other sources

- **Public blockchain data.** Addresses, balances, transactions and NFT ownership.
- **Drop and collection data** from OpenSea and other data providers: names, images, prices, supply and
  timing, and (for the wallets you ask us to check) whether a wallet is eligible for a mint.
- **Wallet providers.** If you connect a wallet, the public address and signatures it shares with us.

### 2.5 What we do not ask for

We do not currently ask for your legal name, a government ID, a postal address, a phone number or bank or
card details. If that changes (for example when paid plans arrive), we will update this Policy first.

Accounts made under an earlier sign-up method (email and password) also have an email address and a
password. The password is stored only as a one-way hash.

## 3. How we use information, and why

| Purpose | Examples | Basis [to be confirmed by counsel] |
| --- | --- | --- |
| Provide the Service | Sign you in, hold and use your Stryx wallets' keys to sign what you instruct or schedule, send transactions, show balances, history and proof-of-mint | Performing our agreement with you |
| Keep it safe | Rate limiting, spending limits, emergency stops, detecting and investigating abuse and security incidents, keeping the security log | Our legitimate interest in security; legal obligations |
| Operate and support | Letting administrators see accounts and activity to run, support and troubleshoot the Service; aggregate statistics on use and reliability | Legitimate interests |
| Communicate | Telling waitlist members when a place opens; service and security messages | Consent (waitlist); legitimate interests |
| Prove acceptance | Keeping the record that you accepted a version of the Terms and this Policy | Legitimate interests; legal claims |
| Comply with the law | Responding to lawful requests, sanctions and other legal duties | Legal obligations |

We do not use your information to make decisions about you by automated means that have legal or similarly
significant effects, and we do not use it for advertising or to build profiles for others.

## 4. Private keys

- **Stryx wallets.** The private key is stored encrypted, using envelope encryption backed by a key
  management service. It is decrypted in memory only for the moment it is needed to sign a transaction you
  instructed or scheduled. Our systems are designed not to log it, and our administrator tools are
  designed not to show it. You can export the key of your Stryx wallet when the Service offers that.
  Deleting a Stryx wallet deletes our stored copy of its key.
- **Connected wallets.** Keys stay with your wallet provider. We never receive or store them.
- No system is perfectly secure. See section 10 and the Terms of Use.

## 5. Who we share information with

We do not sell your personal information. We share it only as follows.

**Stryx administrators** can see account and activity information (for example accounts, wallets'
addresses, mint history and the security log) as needed to run, support and secure the Service. Their
access is itself recorded.

**Service providers** that help us run the Service. They receive only what they need and may use it only
to provide their service to us:

| Provider type | What they receive |
| --- | --- |
| Blockchain networks and RPC (node) providers | Addresses and the transactions we send for you; the public network sees them too |
| OpenSea (data provider) | Requests about drops and collections made by our servers. To check whether one of your Stryx wallets is eligible for a mint, or to complete a mint that requires it, we sign in to OpenSea as that wallet, so OpenSea receives the wallet's address and what it asks for |
| WalletConnect / Reown, if you choose to connect a phone wallet | The connection details needed to link your phone wallet; see their privacy policy |
| Cloud hosting, database and key management providers | The data we store and process, in encrypted or protected form: [list providers once chosen] |

**When the law requires** it, or to protect rights, safety and security, we may disclose information to
courts, authorities or other parties.

**Business changes.** If Stryx is involved in a merger, sale or similar event, information may be
transferred, subject to this Policy.

**At your direction.** For example, when you send assets to an address you provide.

**Your browser and OpenSea's image network.** The landing page's "live drops" strip and the app's Home page
show collection images served from OpenSea's content network. Loading those images makes your browser
contact that network directly, so it can see your IP address and browser details. We ask your browser not
to send a referrer. We do not control that network.

## 6. Cookies and similar technologies

- **One essential cookie.** When you sign in we set a session cookie, `__Host-stryx_session` (named
  `stryx_session` on a non-secure development site). It keeps you signed in and protects against forged
  requests. It is needed for the Service to work, so it does not need your consent. We set no advertising
  or tracking cookies.
- **Storage on your device.** The site and app save small settings in your browser's storage so the page
  behaves as you left it: your light or dark theme, whether the sidebar is pinned, recently used
  collections, your last chosen network for balances, a saved copy of the last drops feed, the visible
  state of a sign-up in progress, and similar. This stays on your device and is not sent to us for
  tracking. You can clear it in your browser settings.
- **Fonts.** The site uses fonts bundled with it rather than loading them from a font provider.

## 7. How long we keep information

| Information | How long [periods to be set by counsel] |
| --- | --- |
| Waitlist email | Until you are invited and sign up, you ask us to remove it, or [12] months pass, whichever is first |
| Account and profile | While your account is open, and for [period] after it closes |
| Stryx wallet records and encrypted keys | While the wallet exists; the key is deleted when you delete the wallet [and from backups within period] |
| Transaction and mint records, NFT ledger | [period], as they are our record of what we sent for you |
| Security log | [period] |
| Acceptance records | For as long as needed to show what you agreed to, [period] after the account closes |
| Rate-limit counters (IP addresses) | About one hour |
| Sessions | Until they expire or you sign out |
| Provider logs | As set by each provider [complete] |

We may keep information longer where the law requires it or to deal with a dispute or investigation.
Blockchain data cannot be deleted by us.

## 8. Where information is processed

[Complete once hosting is chosen: where servers, databases and providers are located, and the safeguards
used where information moves between countries.]

## 9. Your choices and rights

You can:

- **See and correct** your information. You can change your display name and handles in your profile.
- **Ask for a copy** of the personal information we hold about you.
- **Delete** what you can delete yourself: remove a Stryx wallet (which deletes the stored key), clear the
  optional profile fields, and ask us to remove your waitlist entry.
- **Ask us to delete or restrict** other information, close your account, or object to a use of it.
- **Withdraw consent** (for example waitlist emails) at any time.
- **Complain** to your data-protection authority if you think we have handled your information unlawfully.

To make a request, contact us at [CONTACT EMAIL]. We may need to check that it is really you (for an
account, by asking you to sign a message with your wallet). We will answer within the time the law requires
[to be set by counsel]. Some information we must or may keep (section 7), and information already written
to a blockchain cannot be erased.

[Region-specific rights and notices (for example the EU and UK GDPR, Nigeria's data protection law, and
California privacy law) to be added by counsel to match where Stryx offers the Service.]

## 10. Security

We use technical and organisational measures designed to protect information, including encryption of
private keys, hashing of session tokens, access controls on administrator tools, rate limits and a
security log. No system is completely secure, and we cannot guarantee that information will never be
accessed without authorisation. If a breach affects your personal information we will tell you and the
relevant authorities as the law requires.

## 11. Children

The Service is for people aged 18 and over. We do not knowingly collect information from anyone under 18.
If you believe a child has given us information, contact us and we will delete it.

## 12. Links and third parties

The Service connects to third-party wallets, blockchains and websites we do not control. Their handling of
your information is governed by their own policies.

## 13. Changes to this Policy

We may update this Policy. Each version has a number and an effective date. For a material change we will
tell you, and where the law requires we will ask for your agreement before you continue using the affected
features.

## 14. Contact

Stryx\
Address: [REGISTERED ADDRESS]\
Email: [CONTACT EMAIL]
