package mcpserver

// The advertised schemas mirror api/agent-public-schema.js. Validation of tool
// arguments also happens in the handler so callers cannot bypass the contract.
func objectSchema(properties map[string]any, required ...string) map[string]any {
	return map[string]any{"type": "object", "additionalProperties": false, "properties": properties, "required": required}
}

func stringSchema(values ...string) map[string]any {
	s := map[string]any{"type": "string"}
	if len(values) != 0 {
		s["enum"] = values
	}
	return s
}

func inputSchema(name string) map[string]any {
	limit := map[string]any{"type": "integer", "minimum": 1, "maximum": 50}
	cursor := map[string]any{"type": "string", "maxLength": 2048, "description": "At most 2048 UTF-8 bytes."}
	if name == "get_public_content" {
		return map[string]any{"type": "object", "additionalProperties": false, "properties": map[string]any{"kind": stringSchema("profile", "works", "notes"), "id": map[string]any{"type": "string", "pattern": "^[A-Za-z0-9_-]{1,128}$"}}, "anyOf": []any{
			objectSchema(map[string]any{"kind": stringSchema("profile")}, "kind"),
			objectSchema(map[string]any{"kind": stringSchema("works", "notes"), "id": map[string]any{"type": "string", "pattern": "^[A-Za-z0-9_-]{1,128}$"}}, "kind", "id"),
		}}
	}
	properties := map[string]any{"kind": stringSchema("works", "notes", "skills", "timeline"), "limit": limit, "cursor": cursor}
	if name == "search_public_content" {
		properties["kind"] = stringSchema("works", "notes")
		properties["q"] = map[string]any{"type": "string", "maxLength": 120, "pattern": "^[^\\u0000-\\u001f\\u007f-\\u009f]*$"}
		return objectSchema(properties, "kind", "q")
	}
	return objectSchema(properties, "kind")
}

func outputSchema(detail bool) map[string]any {
	nullableString := map[string]any{"type": []string{"string", "null"}}
	timestamp := map[string]any{"type": []string{"string", "null"}, "format": "date-time"}
	strings := map[string]any{"type": "array", "items": stringSchema()}
	properties := map[string]any{
		"id":   map[string]any{"type": "string", "pattern": "^[A-Za-z0-9_-]{1,128}$"},
		"type": stringSchema("work", "note", "skill", "timeline"), "title": stringSchema(), "summary": stringSchema(),
		"canonical_url": map[string]any{"type": "string", "format": "uri"}, "source_url": map[string]any{"type": "string", "format": "uri"},
		"date":         map[string]any{"type": []string{"string", "null"}, "pattern": "^\\d{4}-\\d{2}-\\d{2}$"},
		"published_at": timestamp, "updated_at": timestamp,
		"updated_at_basis":   stringSchema("article-record", "source-file-mtime", "not-tracked"),
		"source_modified_at": map[string]any{"type": "string", "format": "date-time"}, "tags": strings,
		"revision": map[string]any{"type": "string", "pattern": "^sha256:[0-9a-f]{64}$"},
		"name":     stringSchema(), "roles": strings, "bio": stringSchema(), "focus": strings, "links": strings,
		"category": stringSchema(), "href": nullableString,
	}
	required := []string{"id", "type", "title", "summary", "canonical_url", "source_url", "date", "published_at", "updated_at", "updated_at_basis", "tags", "revision"}
	if detail {
		properties["type"] = stringSchema("profile", "work", "note")
		properties["content_markdown"] = stringSchema()
		required = append(required, "content_markdown")
	}
	item := objectSchema(properties, required...)
	base := map[string]any{"schema_version": map[string]any{"const": 1, "type": "integer"}, "generated_at": map[string]any{"type": "string", "format": "date-time"}}
	var success map[string]any
	if detail {
		base["item"] = item
		success = objectSchema(base, "schema_version", "generated_at", "item")
	} else {
		base["kind"] = stringSchema("works", "notes", "skills", "timeline")
		base["query"] = stringSchema()
		base["count"] = map[string]any{"type": "integer", "minimum": 0, "maximum": 50}
		base["total_count"] = map[string]any{"type": "integer", "minimum": 0}
		base["limit"] = map[string]any{"type": "integer", "minimum": 1, "maximum": 50}
		base["next_cursor"] = nullableString
		base["items"] = map[string]any{"type": "array", "maxItems": 50, "items": item}
		success = objectSchema(base, "schema_version", "generated_at", "kind", "query", "count", "total_count", "limit", "next_cursor", "items")
	}
	failure := objectSchema(map[string]any{
		"schema_version": map[string]any{"const": 1, "type": "integer"},
		"error": objectSchema(map[string]any{
			"code":    stringSchema("invalid_request", "invalid_cursor", "not_found", "method_not_allowed", "cursor_expired", "rate_limited", "source_unavailable"),
			"message": stringSchema(),
		}, "code", "message"),
	}, "schema_version", "error")
	return map[string]any{"type": "object", "anyOf": []any{success, failure}}
}
