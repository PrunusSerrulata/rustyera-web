{
        let escaped = text
            .replace('\\', "\\\\")
            .replace('`', "\\`")
            .replace('$', "\\$");
        let script = format!(
            r"(function() {{
                var el = window.{js_var};
                if (!el || !el.isConnected) {{
                    throw new Error('stale element reference');
                }}
                el.focus();

                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {{
                    var nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                        el.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype,
                        'value'
                    ).set;

                    var newValue = el.value + `{escaped}`;
                    nativeInputValueSetter.call(el, newValue);

                    var inputEvent = new InputEvent('input', {{
                        bubbles: true,
                        cancelable: true,
                        inputType: 'insertText',
                        data: `{escaped}`
                    }});
                    el.dispatchEvent(inputEvent);

                    var changeEvent = new Event('change', {{ bubbles: true }});
                    el.dispatchEvent(changeEvent);
                }} else if (el.isContentEditable) {{
                    document.execCommand('insertText', false, `{escaped}`);
                }}
                return true;
            }})()"
        );
        self.evaluate_js(&script).await?;
        Ok(())
    }
