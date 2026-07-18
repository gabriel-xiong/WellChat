import { NextRequest, NextResponse } from "next/server";

async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

function equalBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

function unauthorizedResponse(): NextResponse {
  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      "Cache-Control": "no-store",
      "WWW-Authenticate": 'Basic realm="WellChat Dashboard", charset="UTF-8"',
    },
  });
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const expectedUsername = process.env.ADMIN_DASHBOARD_USERNAME;
  const expectedPassword = process.env.ADMIN_DASHBOARD_PASSWORD;

  if (!expectedUsername || !expectedPassword) {
    return new NextResponse("Dashboard authentication is not configured", { status: 503 });
  }

  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Basic ")) return unauthorizedResponse();

  try {
    const credentials = atob(authorization.slice(6));
    const separatorIndex = credentials.indexOf(":");
    const username = credentials.slice(0, separatorIndex);
    const password = credentials.slice(separatorIndex + 1);

    if (
      separatorIndex < 0 ||
      !equalBytes(await digest(username), await digest(expectedUsername)) ||
      !equalBytes(await digest(password), await digest(expectedPassword))
    ) {
      return unauthorizedResponse();
    }
  } catch {
    return unauthorizedResponse();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*"],
};
