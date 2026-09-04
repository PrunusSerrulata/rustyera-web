{
        let ch = key.chars().next().unwrap_or(' ');
        let key_code = ch as u32;
        let event_type = if is_down { "keydown" } else { "keyup" };

        let escaped_key = key.replace('\\', "\\\\").replace('\'', "\\'");
        let escaped_code = code.replace('\\', "\\\\").replace('\'', "\\'");

        let ctrl_key = modifiers.ctrl;
        let meta_key = modifiers.meta;
        let shift_key = modifiers.shift;
        let alt_key = modifiers.alt;

        // Check for Ctrl+A or Meta+A (select all)
        let is_select_all = is_down && (ch == 'a' || ch == 'A') && (ctrl_key || meta_key);

        let script = if is_select_all {
            // Handle Ctrl+A / Meta+A: select all text
            format!(
                r"(function() {{
                    var activeEl = document.activeElement || document.body;

                    // Dispatch keydown event with modifiers
                    var keydownEvent = new KeyboardEvent('keydown', {{
                        key: '{escaped_key}',
                        code: '{escaped_code}',
                        keyCode: {key_code},
                        which: {key_code},
                        ctrlKey: {ctrl_key},
                        metaKey: {meta_key},
                        shiftKey: {shift_key},
                        altKey: {alt_key},
                        bubbles: true,
                        cancelable: true
                    }});
                    activeEl.dispatchEvent(keydownEvent);

                    // Select all text in input/textarea
                    if (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA') {{
                        activeEl.select();
                    }} else {{
                        document.execCommand('selectAll', false, null);
                    }}

                    return true;
                }})()"
            )
        } else if is_down {
            // For keydown events on printable characters, update input value
            format!(
                r"(function() {{
                    var activeEl = document.activeElement || document.body;

                    // Dispatch keydown event with modifiers
                    var keydownEvent = new KeyboardEvent('keydown', {{
                        key: '{escaped_key}',
                        code: '{escaped_code}',
                        keyCode: {key_code},
                        which: {key_code},
                        ctrlKey: {ctrl_key},
                        metaKey: {meta_key},
                        shiftKey: {shift_key},
                        altKey: {alt_key},
                        bubbles: true,
                        cancelable: true
                    }});
                    activeEl.dispatchEvent(keydownEvent);

                    // If active element is an input or textarea, update value and dispatch input event
                    // Only do this for non-modifier key combos
                    if (!{ctrl_key} && !{meta_key} && !{alt_key}) {{
                        if (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA') {{
                            var nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                                activeEl.tagName === 'INPUT'
                                    ? window.HTMLInputElement.prototype
                                    : window.HTMLTextAreaElement.prototype,
                                'value'
                            ).set;

                            var newValue = activeEl.value + '{escaped_key}';
                            nativeInputValueSetter.call(activeEl, newValue);

                            // Dispatch input event
                            var inputEvent = new InputEvent('input', {{
                                bubbles: true,
                                cancelable: true,
                                inputType: 'insertText',
                                data: '{escaped_key}'
                            }});
                            activeEl.dispatchEvent(inputEvent);
                        }}
                    }}

                    return true;
                }})()"
            )
        } else {
            format!(
                r"(function() {{
                    var activeEl = document.activeElement || document.body;
                    var event = new KeyboardEvent('{event_type}', {{
                        key: '{escaped_key}',
                        code: '{escaped_code}',
                        keyCode: {key_code},
                        which: {key_code},
                        ctrlKey: {ctrl_key},
                        metaKey: {meta_key},
                        shiftKey: {shift_key},
                        altKey: {alt_key},
                        bubbles: true,
                        cancelable: true
                    }});
                    activeEl.dispatchEvent(event);
                    return true;
                }})()"
            )
        };

        self.evaluate_js(&script).await?;
        Ok(())
    }
