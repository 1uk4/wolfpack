/* Setup wizard (work-wolfpack-UpMwxPl). Plain JS. Talks to the main process through window.wolfpack.setup;
 * without it (a plain browser, scripts/serve-setup.mjs) a stub bridge stands in. */
(() => {
	const stub = {
		info: async () => ({ keyEnv: false, keySaved: false, prefill: null }),
		suggestedName: async () => "Maya's wolf",
		checkKey: async (key) => (key === "sk-ok" ? { ok: true } : { ok: false, error: "That key didn't work" }),
		openExternal: async (url) => void window.open(url, "_blank"),
		finish: async (answers) => (console.log("setup.finish", JSON.stringify(answers)), { ok: true }),
	};
	const bridge = window.wolfpack?.setup ?? stub;
	const $ = (s, r = document) => r.querySelector(s);
	const steps = [...document.querySelectorAll(".step")];
	const dots = [...document.querySelectorAll(".dots li")];
	let current = 0;
	let skipKey = false; // Skip was chosen: Finish needs and checks no key (a stored one is kept as it is)
	let keySaved = false; // a key is already stored (or comes from the environment): the page never holds it

	const show = (n) => {
		current = n;
		for (const s of steps) s.hidden = Number(s.dataset.step) !== n;
		dots.forEach((d, i) => d.classList.toggle("on", i <= Math.min(n, 2)));
		const first = steps[n].querySelector("input:not([type=checkbox]):not([hidden]), input");
		first?.focus();
	};
	const setError = (step, msg, input) => {
		$(".error", step).textContent = msg || "";
		if (input) input.setAttribute("aria-invalid", msg ? "true" : "false");
	};

	const keyForm = $("#step-key"), nameForm = $("#step-name"), knowForm = $("#step-knowledge");
	const keyInput = $("#key"), nameInput = $("#name");

	$("#get-key").addEventListener("click", (e) => {
		e.preventDefault();
		bridge.openExternal("https://console.anthropic.com/settings/keys");
	});

	keyForm.addEventListener("submit", async (e) => {
		e.preventDefault();
		const btn = $("button.primary", keyForm);
		btn.disabled = true;
		setError(keyForm, "", keyInput);
		skipKey = false;
		if (keySaved) { btn.disabled = false; return show(1); }
		const r = await bridge.checkKey(keyInput.value.trim());
		btn.disabled = false;
		if (!r.ok) return setError(keyForm, r.error, keyInput);
		show(1);
	});

	// Skip: go on with no key. Whatever was typed (even a rejected key) is dropped, so nothing is stored; Settings adds one later.
	$("#skip-key").addEventListener("click", () => {
		keyInput.value = "";
		skipKey = true;
		setError(keyForm, "", keyInput);
		show(1);
	});

	const wolfIdOk = (n) => /[a-z0-9]/i.test(n);
	nameForm.addEventListener("submit", (e) => {
		e.preventDefault();
		if (!wolfIdOk(nameInput.value)) return setError(nameForm, "Give your wolf a name with at least one letter or digit.", nameInput);
		setError(nameForm, "", nameInput);
		show(2);
	});

	// Knowledge: personal is a fixed, ticked row; "Add a domain" appends name + one-line description rows.
	const list = $("#domains");
	const addRow = (name = "", description = "") => {
		const li = document.createElement("li");
		li.className = "domain-new";
		li.innerHTML = '<div class="row"><input type="text" class="dn" placeholder="name, e.g. startup" maxlength="32" autocomplete="off" spellcheck="false" aria-label="Domain name"><button type="button" class="remove" aria-label="Remove">✕</button></div><input type="text" class="dd" placeholder="One line, e.g. the company I’m starting" maxlength="140" autocomplete="off" aria-label="Description">';
		$(".remove", li).addEventListener("click", () => li.remove());
		list.appendChild(li);
		$(".dn", li).value = name;
		$(".dd", li).value = description;
		if (!name) $(".dn", li).focus();
	};
	$("#add-domain").addEventListener("click", () => addRow());

	const DOMAIN_RE = /^[a-z0-9]{1,32}$/;
	const collectDomains = () => {
		const out = [];
		out.push({ name: "personal", description: "" });
		for (const li of list.querySelectorAll(".domain-new")) {
			const name = $(".dn", li).value.trim().toLowerCase();
			const description = $(".dd", li).value.trim();
			if (!name && !description) continue;
			if (!DOMAIN_RE.test(name)) return { error: `"${name || "(empty)"}" isn't a valid domain name. Use 1-32 lower-case letters and digits.`, input: $(".dn", li) };
			if (out.some((d) => d.name === name)) return { error: `"${name}" is listed twice.`, input: $(".dn", li) };
			out.push({ name, description });
		}
		return { domains: out };
	};

	knowForm.addEventListener("submit", async (e) => {
		e.preventDefault();
		const c = collectDomains();
		if (c.error) return setError(knowForm, c.error, c.input);
		setError(knowForm, "");
		show(3);
		const r = await bridge.finish({ skipKey, apiKey: keyInput.value.trim(), wolfName: nameInput.value.trim(), domains: c.domains });
		if (r && r.ok === false) {
			setError($("#working"), r.error || "Something went wrong.");
			$("#working-back").hidden = false;
			$("h1", $("#working")).textContent = "Couldn't start your wolf";
		}
	});

	for (const b of document.querySelectorAll(".back")) b.addEventListener("click", () => show(current === 3 ? 2 : Math.max(0, current - 1)));

	(async () => {
		const info = (await bridge.info?.()) ?? {};
		nameInput.value = info.prefill?.wolfName || (await bridge.suggestedName()) || "My wolf";
		for (const d of info.prefill?.domains ?? []) if (d.name !== "personal") addRow(d.name, d.description);
		if (info.keyEnv) {
			// WOLFPACK_APP_API_KEY dev/test override: the sign-in step is skipped; main checks the key when finishing.
			keySaved = true;
			show(1);
			return;
		}
		if (info.keySaved) {
			// A key is stored from an earlier try. It never comes to the page: Continue uses it, Replace asks for a new one.
			keySaved = true;
			keyInput.hidden = true;
			$("label[for=key]", keyForm).hidden = true;
			$("#key-saved").hidden = false;
			$("#skip-key").textContent = "Keep the saved key and continue";
			$("#replace-key").addEventListener("click", () => {
				keySaved = false;
				keyInput.hidden = false;
				$("label[for=key]", keyForm).hidden = false;
				$("#key-saved").hidden = true;
				keyInput.focus();
			});
		}
		show(0);
	})();
})();
