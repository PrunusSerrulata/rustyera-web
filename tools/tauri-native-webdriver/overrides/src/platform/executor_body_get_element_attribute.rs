{
        let escaped_name = name.replace('\\', "\\\\").replace('\'', "\\'");
        let script = format!(
            r"(function() {{
                var el = window.{js_var};
                if (!el || !el.isConnected) {{
                    throw new Error('stale element reference');
                }}
                var attrName = '{escaped_name}'.toLowerCase();
                var tagName = el.tagName.toLowerCase();

                // Per W3C WebDriver spec, return property values for certain attributes
                if (attrName === 'value') {{
                    if (tagName === 'input' || tagName === 'textarea') {{
                        return el.value;
                    }}
                }}
                if (attrName === 'checked') {{
                    if (tagName === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {{
                        return el.checked ? 'true' : null;
                    }}
                }}
                if (attrName === 'selected') {{
                    if (tagName === 'option') {{
                        return el.selected ? 'true' : null;
                    }}
                }}

                return el.getAttribute('{escaped_name}');
            }})()"
        );
        let result = self.evaluate_js(&script).await?;

        if let Some(value) = result.get("value") {
            if value.is_null() {
                return Ok(None);
            }
            if let Some(s) = value.as_str() {
                return Ok(Some(s.to_string()));
            }
        }
        Ok(None)
    }
