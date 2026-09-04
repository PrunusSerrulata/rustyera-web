{
        let event_name = match event_type {
            PointerEventType::Down => "mousedown",
            PointerEventType::Up => "mouseup",
            PointerEventType::Move => "mousemove",
            // Manually dispatched mousedown/mouseup do NOT make the browser
            // synthesize a click, so element click handlers never fire. The
            // actions handler emits this explicitly after a same-spot down+up.
            PointerEventType::Click => "click",
        };

        let buttons = if matches!(event_type, PointerEventType::Down) {
            1 << button
        } else {
            0
        };
        let script = format!(
            r"(function() {{
                var el = document.elementFromPoint({x}, {y});
                if (!el) el = document.body;

                var event = new MouseEvent('{event_name}', {{
                    bubbles: true,
                    cancelable: true,
                    clientX: {x},
                    clientY: {y},
                    button: {button},
                    buttons: {buttons}
                }});
                el.dispatchEvent(event);
                return true;
            }})()"
        );

        self.evaluate_js(&script).await?;
        Ok(())
    }
