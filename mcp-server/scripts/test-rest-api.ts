import { existsSync } from "node:fs";

async function main() {
  console.log("Starting REST API integration test...");

  // Set test env variables
  process.env.PORT = "3333";
  process.env.JOBSYNC_REMOTE_BEARER_TOKEN = "test-token-123";
  process.env.NODE_ENV = "test";

  // Dynamically import the http module which starts the server
  const { httpServer } = await import("../src/http.js");

  // Let the server spin up
  await new Promise((r) => setTimeout(r, 1000));

  let failed = false;

  // Test 1: Healthcheck
  try {
    const res = await fetch("http://localhost:3333/healthz");
    const json = (await res.json()) as any;
    if (res.status === 200 && json.ok && json.service === "jobsync-mcp") {
      console.log("✓ Test 1 Passed: GET /healthz is active");
    } else {
      console.error("✗ Test 1 Failed: GET /healthz returned:", res.status, json);
      failed = true;
    }
  } catch (err) {
    console.error("✗ Test 1 Failed with error:", err);
    failed = true;
  }

  // Test 2: Unauthenticated POST request
  try {
    const res = await fetch("http://localhost:3333/api/auto-apply/inspect", {
      method: "POST",
      body: JSON.stringify({ applyLink: "http://example.com" }),
    });
    const json = (await res.json()) as any;
    if (res.status === 401 && json.error === "unauthorized") {
      console.log("✓ Test 2 Passed: Unauthenticated request rejected with 401");
    } else {
      console.error("✗ Test 2 Failed: Unauthenticated request returned:", res.status, json);
      failed = true;
    }
  } catch (err) {
    console.error("✗ Test 2 Failed with error:", err);
    failed = true;
  }

  // Test 3: Authenticated request with invalid token
  try {
    const res = await fetch("http://localhost:3333/api/auto-apply/inspect", {
      method: "POST",
      headers: {
        Authorization: "Bearer bad-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ applyLink: "http://example.com" }),
    });
    const json = (await res.json()) as any;
    if (res.status === 401 && json.error === "unauthorized") {
      console.log("✓ Test 3 Passed: Invalid token rejected with 401");
    } else {
      console.error("✗ Test 3 Failed: Invalid token returned:", res.status, json);
      failed = true;
    }
  } catch (err) {
    console.error("✗ Test 3 Failed with error:", err);
    failed = true;
  }

  // Test 4: OPTIONS pre-flight check
  try {
    const res = await fetch("http://localhost:3333/api/auto-apply/inspect", {
      method: "OPTIONS",
    });
    if (res.status === 204) {
      console.log("✓ Test 4 Passed: CORS pre-flight OPTIONS check succeeded");
    } else {
      console.error("✗ Test 4 Failed: OPTIONS pre-flight returned status:", res.status);
      failed = true;
    }
  } catch (err) {
    console.error("✗ Test 4 Failed with error:", err);
    failed = true;
  }

  // Test 5: POST /api/auto-apply/fill validation (missing parameters)
  try {
    const res = await fetch("http://localhost:3333/api/auto-apply/fill", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token-123",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const json = (await res.json()) as any;
    if (res.status === 400 && json.error) {
      console.log("✓ Test 5 Passed: Missing fields array rejected with 400");
    } else {
      console.error("✗ Test 5 Failed: Missing fields returned:", res.status, json);
      failed = true;
    }
  } catch (err) {
    console.error("✗ Test 5 Failed with error:", err);
    failed = true;
  }

  // Test 6: POST /api/auto-apply/fill success mapping
  try {
    const res = await fetch("http://localhost:3333/api/auto-apply/fill", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token-123",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fields: [
          { selector: "#first_name", label: "First Name", type: "text" },
          { selector: "#email", label: "Email Address", type: "text" },
          { selector: "#unanswered_q", label: "Why do you want this job?", type: "textarea" },
        ],
        profile: {
          personal: {
            firstName: "John",
            lastName: "Doe",
            email: "john@example.com",
          },
          customAnswers: {
            "#unanswered_q": "I love automation and writing clean code.",
          },
        },
      }),
    });
    const json = (await res.json()) as any;
    if (res.status === 200 && json.success && json.instructions) {
      const first = json.instructions.find((i: any) => i.selector === "#first_name");
      const email = json.instructions.find((i: any) => i.selector === "#email");
      const unanswered = json.instructions.find((i: any) => i.selector === "#unanswered_q");

      if (first?.value === "John" && email?.value === "john@example.com" && unanswered?.value.includes("automation")) {
        console.log("✓ Test 6 Passed: /fill successfully mapped personal profile and custom answers");
      } else {
        console.error("✗ Test 6 Failed: Mapped instructions were incorrect:", json.instructions);
        failed = true;
      }
    } else {
      console.error("✗ Test 6 Failed: POST /fill returned:", res.status, json);
      failed = true;
    }
  } catch (err) {
    console.error("✗ Test 6 Failed with error:", err);
    failed = true;
  }

  httpServer.close();
  if (failed) {
    console.error("\nSome tests FAILED.");
    process.exit(1);
  } else {
    console.log("\nAll REST API integration tests PASSED! 🎉");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Fatal test error:", err);
  process.exit(1);
});
