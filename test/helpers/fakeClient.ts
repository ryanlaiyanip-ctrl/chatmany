// A fake InstagramClient that records calls and can be told to fail the next N calls of a method
// (to exercise send-failure retry paths). Cast to InstagramClient when constructing the Engine.

import { InstagramApiError } from "../../src/api/client";
import type { InstagramClient } from "../../src/api/client";

type Method = "privateReply" | "reply" | "like" | "quick" | "button" | "text";

export class FakeClient {
  calls: Record<Method, unknown[]> = {
    privateReply: [],
    reply: [],
    like: [],
    quick: [],
    button: [],
    text: [],
  };
  /** How many upcoming calls of each method should throw a (non-rate-limit) error. */
  failNext: Partial<Record<Method, number>> = {};
  /**
   * How many upcoming calls of each method should DELIVER and then throw — i.e. Instagram
   * accepted and sent the message, but we never learned that (timeout, dropped connection,
   * 5xx after processing). The call is recorded before the throw, so `calls` reflects what
   * the recipient actually received. This is the case that produces real duplicate DMs.
   */
  deliverThenFailNext: Partial<Record<Method, number>> = {};

  private guard(m: Method): void {
    const n = this.failNext[m] ?? 0;
    if (n > 0) {
      this.failNext[m] = n - 1;
      throw new InstagramApiError("simulated failure", 500);
    }
  }

  /** Call AFTER recording the call, to simulate a delivered-but-errored send. */
  private guardAfter(m: Method): void {
    const n = this.deliverThenFailNext[m] ?? 0;
    if (n > 0) {
      this.deliverThenFailNext[m] = n - 1;
      // Deliberately NOT an InstagramApiError: this models the connection dropping after
      // Instagram already accepted the send, so we never receive a status at all.
      throw new Error("socket hang up");
    }
  }

  async privateReplyWithButtons(commentId: string, text: string, buttons: unknown) {
    this.guard("privateReply");
    this.calls.privateReply.push({ commentId, text, buttons });
    this.guardAfter("privateReply");
    return { message_id: "m" };
  }
  async replyToComment(commentId: string, message: string) {
    this.guard("reply");
    this.calls.reply.push({ commentId, message });
    return { id: "r" };
  }
  // Deliberately still present so the test above can assert it is NEVER called. The real
  // InstagramClient has no likeComment() — Instagram's API cannot like a comment.
  async likeComment(commentId: string) {
    this.guard("like");
    this.calls.like.push({ commentId });
    return { success: true };
  }
  async sendQuickReplies(igsid: string, text: string, quickReplies: unknown) {
    this.guard("quick");
    this.calls.quick.push({ igsid, text, quickReplies });
    this.guardAfter("quick");
    return { message_id: "m" };
  }
  /** Button-template send to an IGSID — how the follow gate goes out (see transitions.ts). */
  async sendButtonTemplate(recipient: { igsid?: string; commentId?: string }, text: string, buttons: unknown) {
    this.guard("button");
    this.calls.button.push({ igsid: recipient.igsid, text, buttons });
    this.guardAfter("button");
    return { message_id: "m" };
  }
  async sendText(igsid: string, text: string) {
    this.guard("text");
    this.calls.text.push({ igsid, text });
    this.guardAfter("text");
    return { message_id: "m" };
  }
  // ---- webhook subscription (admin route) ----
  /** What Meta currently reports for this account. Tests set this to model a partial subscription. */
  subscribedFields: string[] = [];
  /** Fields the next subscribeToWebhooks call will actually persist — defaults to all requested. */
  acceptFields: string[] | null = null;
  subscribeCalls = 0;
  /** Make the read-back throw, to exercise the "subscribed but unconfirmed" path. */
  failReadBack = false;

  async subscribeToWebhooks(fields = "comments,messages") {
    this.subscribeCalls++;
    const requested = fields.split(",");
    this.subscribedFields = this.acceptFields ?? requested;
    return { success: true };
  }
  async getWebhookSubscriptions() {
    if (this.failReadBack) throw new Error("graph unreachable");
    return this.subscribedFields.length ? [{ subscribed_fields: [...this.subscribedFields] }] : [];
  }

  asClient(): InstagramClient {
    return this as unknown as InstagramClient;
  }
}
