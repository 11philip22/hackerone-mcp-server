# HackerOne MCP Server

Unofficial MCP server that gives Codex, Claude Code, or any MCP client full access to your HackerOne reports, programs, earnings, and scope data via the HackerOne API — including submitting reports and responding to triage.

## Setup

Install Node.js and npm, then use the published [hackerone-mcp-server package](https://www.npmjs.com/package/hackerone-mcp-server) through `npx`.

### 1. Get your HackerOne API token

Go to **HackerOne > Settings > API Token** and generate one.

### 2. Add to your MCP client

Replace `your-username` and `your-api-token` below with your HackerOne credentials.

#### Codex

```toml
[mcp_servers.hackerone]
command = "npx"
args = ["-y", "hackerone-mcp-server@latest"]
startup_timeout_sec = 60
env = { "H1_USERNAME" = "your-username", "H1_API_TOKEN" = "your-api-token" }
```

#### Claude Code

```json
{
  "mcpServers": {
    "hackerone": {
      "command": "npx",
      "args": ["-y", "hackerone-mcp-server@latest"],
      "env": {
        "H1_USERNAME": "your-username",
        "H1_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

## Build from source

For local development:

```bash
git clone https://github.com/11philip22/hackerone-mcp-server.git
cd hackerone-mcp-server
npm install
npm run build
```

To use your local build, set the MCP command to `node` and its arguments to `["/absolute/path/to/hackerone-mcp-server/dist/index.js"]`, keeping the same environment variables.

## Tools

### Read

| Tool | Description |
|------|-------------|
| `search_reports` | Search and filter your reports by keyword, program, severity, or state |
| `get_report` | Get full report details including CVSS vector, bounty amounts, and attachments |
| `get_report_with_conversation` | Get a report with its triage conversation thread |
| `get_report_activities` | Get activity timeline (comments, state changes, bounties) |
| `list_programs` | List all bug bounty programs you have access to (auto-paginates) |
| `get_program_details` | Get single program info: policy, response times, metrics |
| `get_program_signal_requirements` | Get a public program's minimum past-year signal threshold and whether requirements are enabled |
| `get_program_scope` | Get all in-scope assets for a program (auto-paginates) |
| `get_program_weaknesses` | Get accepted CWE/weakness types for a program (auto-paginates) |
| `get_earnings` | Get your bounty earnings history (amounts, dates, programs) |
| `get_hacker_profile` | Get your reputation, signal, impact, and rank |
| `get_balance` | Get your current unpaid bounty balance |
| `analyze_report_patterns` | Analyze your hunting patterns (severity distribution, top programs, weakness types) |
| `search_disclosed_reports` | Search publicly disclosed reports on hacktivity — great for recon and learning |

### Write

| Tool | Description |
|------|-------------|
| `submit_report` | Submit a new vulnerability report to a program |
| `add_comment` | Add a comment to an existing report (respond to triage) |
| `close_report` | Withdraw/close one of your own reports |

## Usage Examples

**Submit a report directly:**
```
Submit this SSRF finding to the uber program with critical severity. Here's my writeup: [paste]
```

**Respond to triage:**
```
Add a comment to report #2345678: "Here's the updated PoC with the new endpoint..."
```

**Draft a report matching your style:**
```
Find my resolved critical reports and use the same structure to draft a new report for this SSRF I found.
```

**Learn from triage conversations:**
```
Show me the triage conversation on report #2345678. What questions did they ask?
```

**Research what gets paid:**
```
Search disclosed reports on the uber program for SSRF — what did they pay?
```

**Check program details before hunting:**
```
Show me the uber program details — what are their response times?
```

**Check your stats:**
```
Show my hacker profile — what's my current reputation and signal?
```

**Check a program's signal requirement:**
```
What signal do I need to submit reports to the uber program?
```

**Track earnings:**
```
Show my recent bounty earnings and current balance
```

**Analyze patterns:**
```
Analyze my report patterns — what severity gets resolved most?
```
