{
        let script = format!(
            r"(function() {{
                var el = window.{js_var};
                if (!el || !el.isConnected) {{
                    throw new Error('stale element reference');
                }}

                // Check for explicit role attribute first
                var explicitRole = el.getAttribute('role');
                if (explicitRole) return explicitRole;

                // Try computedRole if available (Chrome/Edge)
                if (el.computedRole) return el.computedRole;

                // Compute implicit role based on element type
                var tag = el.tagName.toLowerCase();
                var type = el.type ? el.type.toLowerCase() : '';

                // Map elements to their implicit ARIA roles
                var roleMap = {{
                    'a': el.hasAttribute('href') ? 'link' : 'generic',
                    'article': 'article',
                    'aside': 'complementary',
                    'button': 'button',
                    'datalist': 'listbox',
                    'details': 'group',
                    'dialog': 'dialog',
                    'fieldset': 'group',
                    'figure': 'figure',
                    'footer': 'contentinfo',
                    'form': 'form',
                    'h1': 'heading',
                    'h2': 'heading',
                    'h3': 'heading',
                    'h4': 'heading',
                    'h5': 'heading',
                    'h6': 'heading',
                    'header': 'banner',
                    'hr': 'separator',
                    'img': el.getAttribute('alt') === '' ? 'presentation' : 'img',
                    'li': 'listitem',
                    'main': 'main',
                    'menu': 'list',
                    'meter': 'meter',
                    'nav': 'navigation',
                    'ol': 'list',
                    'optgroup': 'group',
                    'option': 'option',
                    'output': 'status',
                    'progress': 'progressbar',
                    'section': 'region',
                    'select': el.multiple ? 'listbox' : 'combobox',
                    'summary': 'button',
                    'table': 'table',
                    'tbody': 'rowgroup',
                    'td': 'cell',
                    'textarea': 'textbox',
                    'tfoot': 'rowgroup',
                    'th': 'columnheader',
                    'thead': 'rowgroup',
                    'tr': 'row',
                    'ul': 'list'
                }};

                // Handle input types
                if (tag === 'input') {{
                    var inputRoles = {{
                        'button': 'button',
                        'checkbox': 'checkbox',
                        'email': 'textbox',
                        'image': 'button',
                        'number': 'spinbutton',
                        'radio': 'radio',
                        'range': 'slider',
                        'reset': 'button',
                        'search': 'searchbox',
                        'submit': 'button',
                        'tel': 'textbox',
                        'text': 'textbox',
                        'url': 'textbox'
                    }};
                    return inputRoles[type] || 'textbox';
                }}

                return roleMap[tag] || '';
            }})()"
        );
        let result = self.evaluate_js(&script).await?;
        extract_string_value(&result)
    }
