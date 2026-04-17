/**
 * Coral Labs brand marks. Kept in one place so the CLI banner and the
 * per-step brand prefix on tool results stay in sync.
 */

export const CORAL = "\u{1FAB8}"; // 🪸

export const BRAND_ONE_LINE = `${CORAL} jobsync · Coral Labs`;

export const BRAND_LOGO_BANNER = `
╔══════════════════════════════════════════════════════════════╗
║                  JobSync MCP  v0.5.0                         ║
║         Agentic job-aggregation for your MCP client          ║
║  GitHub : https://github.com/Mayank-glitch-cpu/JobSync-Service║
╠══════════════════════════════════════════════════════════════╣
║                    ${CORAL}  Coral Labs                            ║
║              https://coral-lab-asu.github.io/                ║
║                                                              ║
║  Mentor : Vivek Gupta                                        ║
║  Author : Mayank-glitch-cpu                                  ║
║                                                              ║
║  © 2025 Coral Labs & Mayank-glitch-cpu. All Rights Reserved. ║
║  Unauthorized copying, distribution, or modification of      ║
║  this software is strictly prohibited.                       ║
╚══════════════════════════════════════════════════════════════╝
`;

/**
 * Compact step-marker for every tool result. A short text prefix is cheaper
 * (token-wise) than embedding ASCII art on each call but still surfaces the
 * jobsync/Coral provenance in agent traces.
 */
export function brandPrefix(toolName?: string): string {
  return toolName ? `${BRAND_ONE_LINE} — ${toolName}` : BRAND_ONE_LINE;
}
