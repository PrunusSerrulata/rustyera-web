{
        let script = format!(
            r#"(function() {{
                var el = window.{js_var};
                if (!el || !el.isConnected) {{
                    throw new Error('stale element reference');
                }}

                // Try computedName if available (Chrome/Edge)
                if (el.computedName) return el.computedName;

                // Check aria-labelledby first (highest priority)
                var labelledBy = el.getAttribute('aria-labelledby');
                if (labelledBy) {{
                    var labels = labelledBy.split(/\s+/).map(function(id) {{
                        var labelEl = document.getElementById(id);
                        return labelEl ? labelEl.textContent : '';
                    }});
                    var combined = labels.join(' ').trim();
                    if (combined) return combined;
                }}

                // Check aria-label
                var ariaLabel = el.getAttribute('aria-label');
                if (ariaLabel) return ariaLabel;

                // For inputs, check associated label
                var tag = el.tagName.toLowerCase();
                if (tag === 'input' || tag === 'textarea' || tag === 'select') {{
                    // Check for label with 'for' attribute
                    if (el.id) {{
                        var label = document.querySelector("label[for='" + el.id + "']");
                        if (label) return label.textContent.trim();
                    }}
                    // Check for wrapping label
                    var parentLabel = el.closest('label');
                    if (parentLabel) {{
                        // Get label text excluding the input's value
                        var clone = parentLabel.cloneNode(true);
                        var inputs = clone.querySelectorAll('input, textarea, select');
                        inputs.forEach(function(input) {{ input.remove(); }});
                        var labelText = clone.textContent.trim();
                        if (labelText) return labelText;
                    }}
                    // Check placeholder
                    if (el.placeholder) return el.placeholder;
                }}

                // For buttons and links, use text content
                if (tag === 'button' || tag === 'a') {{
                    return el.textContent.trim();
                }}

                // For images, use alt text
                if (tag === 'img') {{
                    return el.getAttribute('alt') || '';
                }}

                // Check title attribute as last resort
                var title = el.getAttribute('title');
                if (title) return title;

                // Fall back to text content for other elements
                return el.textContent ? el.textContent.trim() : '';
            }})()"#
        );
        let result = self.evaluate_js(&script).await?;
        extract_string_value(&result)
    }
