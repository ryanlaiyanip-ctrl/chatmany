-- How many times we have re-asked this person for their email.
--
-- The email step re-asks whenever a reply isn't an address, which was uncapped: someone who kept
-- talking ("why do you need that?", "who is this?", a sticker) received one more DM every time.
-- Repeatedly DMing somebody who isn't engaging is exactly what platform spam detection looks for,
-- so this bounds it. Reaching the cap only stops the nagging — the conversation stays open, and a
-- real address arriving later is still captured and still delivers the reward.
ALTER TABLE conversations ADD COLUMN email_retries INTEGER DEFAULT 0;
