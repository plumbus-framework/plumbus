import { describe, expect, it } from "vitest";
import { errorToHttpResponse, errorToHttpStatus } from "../http.js";
import { createErrorService } from "../index.js";

describe("errorToHttpStatus", () => {
  const errors = createErrorService();

  it("maps validation to 400", () => {
    expect(errorToHttpStatus(errors.validation("bad"))).toBe(400);
  });

  it("maps notFound to 404", () => {
    expect(errorToHttpStatus(errors.notFound("missing"))).toBe(404);
  });

  it("maps forbidden to 403", () => {
    expect(errorToHttpStatus(errors.forbidden("denied"))).toBe(403);
  });

  it("maps conflict to 409", () => {
    expect(errorToHttpStatus(errors.conflict("dup"))).toBe(409);
  });

  it("maps internal to 500", () => {
    expect(errorToHttpStatus(errors.internal("oops"))).toBe(500);
  });
});

describe("errorToHttpResponse", () => {
  const errors = createErrorService();

  it("returns structured HTTP error response", () => {
    const resp = errorToHttpResponse(
      errors.validation("Invalid email", { field: "email" }),
    );

    expect(resp.statusCode).toBe(400);
    expect(resp.body.error.code).toBe("validation");
    expect(resp.body.error.message).toBe("Invalid email");
    expect(resp.body.error.metadata).toEqual({ field: "email" });
  });
});
