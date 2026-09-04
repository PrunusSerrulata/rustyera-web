{
        let (js_key, js_code, key_code) = match key {
            "\u{E007}" => ("Enter", "Enter", 13),
            "\u{E003}" => ("Backspace", "Backspace", 8),
            "\u{E004}" => ("Tab", "Tab", 9),
            "\u{E006}" => ("Enter", "NumpadEnter", 13),
            "\u{E00C}" => ("Escape", "Escape", 27),
            "\u{E00D}" => (" ", "Space", 32),
            "\u{E012}" => ("ArrowLeft", "ArrowLeft", 37),
            "\u{E013}" => ("ArrowUp", "ArrowUp", 38),
            "\u{E014}" => ("ArrowRight", "ArrowRight", 39),
            "\u{E015}" => ("ArrowDown", "ArrowDown", 40),
            "\u{E017}" => ("Delete", "Delete", 46),
            "\u{E031}" => ("F1", "F1", 112),
            "\u{E032}" => ("F2", "F2", 113),
            "\u{E033}" => ("F3", "F3", 114),
            "\u{E034}" => ("F4", "F4", 115),
            "\u{E035}" => ("F5", "F5", 116),
            "\u{E036}" => ("F6", "F6", 117),
            "\u{E037}" => ("F7", "F7", 118),
            "\u{E038}" => ("F8", "F8", 119),
            "\u{E039}" => ("F9", "F9", 120),
            "\u{E03A}" => ("F10", "F10", 121),
            "\u{E03B}" => ("F11", "F11", 122),
            "\u{E03C}" => ("F12", "F12", 123),
            "\u{E008}" => ("Shift", "ShiftLeft", 16),
            "\u{E009}" => ("Control", "ControlLeft", 17),
            "\u{E00A}" => ("Alt", "AltLeft", 18),
            "\u{E03D}" => ("Meta", "MetaLeft", 91),
            _ => {
                let ch = key.chars().next().unwrap_or(' ');
                let upper = ch.to_ascii_uppercase();
                let code = if ch.is_ascii_alphabetic() {
                    format!("Key{upper}")
                } else if ch.is_ascii_digit() {
                    format!("Digit{ch}")
                } else {
                    key.to_string()
                };
                return self
                    .dispatch_regular_key(key, &code, is_down, modifiers)
                    .await;
            }
        };

        let event_type = if is_down { "keydown" } else { "keyup" };

        // For special keys that modify input (Backspace, Delete), handle value changes
        let script = if is_down && (js_key == "Backspace" || js_key == "Delete") {
            format!(
                r"(function() {{
                    var activeEl = document.activeElement || document.body;

                    // Dispatch keydown event
                    var keydownEvent = new KeyboardEvent('keydown', {{
                        key: '{js_key}',
                        code: '{js_code}',
                        keyCode: {key_code},
                        which: {key_code},
                        bubbles: true,
                        cancelable: true
                    }});
                    activeEl.dispatchEvent(keydownEvent);

                    // If active element is an input or textarea, handle deletion
                    if (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA') {{
                        var nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                            activeEl.tagName === 'INPUT'
                                ? window.HTMLInputElement.prototype
                                : window.HTMLTextAreaElement.prototype,
                            'value'
                        ).set;

                        var currentValue = activeEl.value;
                        var selStart = activeEl.selectionStart;
                        var selEnd = activeEl.selectionEnd;
                        var newValue;
                        var inputType;

                        // Check if there's a selection
                        if (selStart !== selEnd) {{
                            // Delete selection
                            newValue = currentValue.slice(0, selStart) + currentValue.slice(selEnd);
                            inputType = 'deleteContentBackward';
                            // Set cursor position after deletion
                            nativeInputValueSetter.call(activeEl, newValue);
                            activeEl.setSelectionRange(selStart, selStart);
                        }} else if ('{js_key}' === 'Backspace' && selStart > 0) {{
                            newValue = currentValue.slice(0, selStart - 1) + currentValue.slice(selStart);
                            inputType = 'deleteContentBackward';
                            nativeInputValueSetter.call(activeEl, newValue);
                            activeEl.setSelectionRange(selStart - 1, selStart - 1);
                        }} else if ('{js_key}' === 'Delete' && selStart < currentValue.length) {{
                            newValue = currentValue.slice(0, selStart) + currentValue.slice(selStart + 1);
                            inputType = 'deleteContentForward';
                            nativeInputValueSetter.call(activeEl, newValue);
                            activeEl.setSelectionRange(selStart, selStart);
                        }} else {{
                            return true; // Nothing to delete
                        }}

                        // Dispatch input event
                        var inputEvent = new InputEvent('input', {{
                            bubbles: true,
                            cancelable: true,
                            inputType: inputType
                        }});
                        activeEl.dispatchEvent(inputEvent);
                    }}

                    return true;
                }})()"
            )
        } else if is_down
            && (js_key == "ArrowDown"
                || js_key == "ArrowUp"
                || js_key == "ArrowLeft"
                || js_key == "ArrowRight")
        {
            // Handle arrow keys on radio buttons for navigation
            let go_forward = js_key == "ArrowDown" || js_key == "ArrowRight";
            format!(
                r#"(function() {{
                    var activeEl = document.activeElement || document.body;

                    // Dispatch keydown event first
                    var keydownEvent = new KeyboardEvent('keydown', {{
                        key: '{js_key}',
                        code: '{js_code}',
                        keyCode: {key_code},
                        which: {key_code},
                        bubbles: true,
                        cancelable: true
                    }});
                    activeEl.dispatchEvent(keydownEvent);

                    // If active element is a radio button, handle navigation
                    if (activeEl.tagName === 'INPUT' && activeEl.type === 'radio' && activeEl.name) {{
                        var name = activeEl.name;
                        var radios = Array.from(document.querySelectorAll("input[type='radio'][name='" + name + "']"));
                        var currentIndex = radios.indexOf(activeEl);

                        if (currentIndex !== -1 && radios.length > 1) {{
                            var nextIndex;
                            if ({go_forward}) {{
                                // ArrowDown/ArrowRight - go to next
                                nextIndex = (currentIndex + 1) % radios.length;
                            }} else {{
                                // ArrowUp/ArrowLeft - go to previous
                                nextIndex = (currentIndex - 1 + radios.length) % radios.length;
                            }}

                            var nextRadio = radios[nextIndex];
                            nextRadio.checked = true;
                            nextRadio.focus();

                            // Dispatch change event
                            var changeEvent = new Event('change', {{ bubbles: true }});
                            nextRadio.dispatchEvent(changeEvent);
                        }}
                    }}

                    return true;
                }})()"#
            )
        } else {
            format!(
                r"(function() {{
                    var event = new KeyboardEvent('{event_type}', {{
                        key: '{js_key}',
                        code: '{js_code}',
                        keyCode: {key_code},
                        which: {key_code},
                        bubbles: true,
                        cancelable: true
                    }});
                    var activeEl = document.activeElement || document.body;
                    activeEl.dispatchEvent(event);
                    return true;
                }})()"
            )
        };

        self.evaluate_js(&script).await?;
        Ok(())
    }
