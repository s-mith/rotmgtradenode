// The login desk's code book: a /tell carrying a registered code proves the sender's character.
import { describe, expect, it } from "vitest";
import { LoginCodes } from "../stores";

describe("LoginCodes", () => {
  it("reports the character name without the suffix Realm puts on the wire", () => {
    const codes = new LoginCodes();
    codes.register("ABCD2345EF");
    expect(codes.noteTell("Friend,a19d,fe3", "by pasting this im logging into rotmgtradenode ABCD2345EF")).toBe(true);
    expect(codes.state("ABCD2345EF")).toEqual({ state: "verified", ign: "Friend" });
  });
  it("hands out a verified code once", () => {
    const codes = new LoginCodes();
    codes.register("WXYZ6789AB");
    codes.noteTell("Friend", "WXYZ6789AB");
    expect(codes.state("WXYZ6789AB").state).toBe("verified");
    expect(codes.state("WXYZ6789AB").state).toBe("expired");
  });
});
