use super::view_reference::single_view;
use crate::api::DustApiClient;

pub async fn cmd_list_tools(client: &DustApiClient, server_name: &str) -> anyhow::Result<()> {
    let views = client.list_tools(Some(server_name), false).await?;
    let view = single_view(&views, server_name)?;

    if view.server.tools.is_empty() {
        println!("No tools found on server '{server_name}'.");
        return Ok(());
    }

    for tool in &view.server.tools {
        print!(
            "{}",
            format_tool_listing(&tool.name, &tool.description, tool.input_schema.as_ref())
        );
    }

    Ok(())
}

/// Human- and agent-readable listing: name, description, and the raw JSON Schema
/// accepted by `--args-json` / `tools.call` (not the legacy `--key value` projection).
fn format_tool_listing(
    name: &str,
    description: &str,
    input_schema: Option<&serde_json::Value>,
) -> String {
    let mut out = format!("{name}:\n");
    if !description.is_empty() {
        out.push_str(&format!("  {description}\n"));
    }
    match input_schema {
        Some(schema) => {
            out.push_str("  input_schema:\n");
            let pretty =
                serde_json::to_string_pretty(schema).unwrap_or_else(|_| schema.to_string());
            for line in pretty.lines() {
                out.push_str("    ");
                out.push_str(line);
                out.push('\n');
            }
        }
        None => out.push_str("  input_schema: (none)\n"),
    }
    out.push('\n');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prints_raw_input_schema_not_key_flags() {
        let listing = format_tool_listing(
            "search",
            "Find messages.",
            Some(&serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search text" },
                    "limit": { "type": "number" },
                },
                "required": ["query"],
            })),
        );

        assert!(listing.starts_with("search:\n"));
        assert!(listing.contains("  Find messages.\n"));
        assert!(listing.contains("  input_schema:\n"));
        assert!(listing.contains("\"query\""));
        assert!(listing.contains("\"type\": \"string\""));
        assert!(listing.contains("\"required\""));
        assert!(
            !listing.contains("--query"),
            "must not project schema into legacy --key flags"
        );
    }

    #[test]
    fn prints_none_when_schema_missing() {
        let listing = format_tool_listing("ping", "", None);
        assert_eq!(listing, "ping:\n  input_schema: (none)\n\n");
    }
}
