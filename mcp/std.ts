const CAT_namespace = 0;
const CAT_container = 1;
const CAT_global_variable = 2;
const CAT_function = 3;
const CAT_primitive = 4;
const CAT_error_set = 5;
const CAT_global_const = 6;
const CAT_alias = 7;
const CAT_type = 8;
const CAT_type_type = 9;
const CAT_type_function = 10;

const LOG_err = 0;
const LOG_warn = 1;
const LOG_info = 2;
const LOG_debug = 3;

const domContent: any = typeof document !== "undefined" ? document.getElementById("content") : null;
const domSearch: any = typeof document !== "undefined" ? document.getElementById("search") : null;
const domErrors: any = typeof document !== "undefined" ? document.getElementById("errors") : null;
const domErrorsText: any =
    typeof document !== "undefined" ? document.getElementById("errorsText") : null;

var searchTimer: any = null;

const curNav = {
    tag: 0,
    decl: null,
    path: null,
};
var curNavSearch = "";

const moduleList: any = [];

var wasm_exports: any = null;

const text_decoder = new TextDecoder();
const text_encoder = new TextEncoder();

declare global {
    interface Window {
        wasm?: any;
    }
}

export function startDocsViewer() {
    const wasm_promise = fetch("main.wasm");
    const sources_promise = fetch("sources.tar").then((response) => {
        if (!response.ok) throw new Error("unable to download sources");
        return response.arrayBuffer();
    });

    WebAssembly.instantiateStreaming(wasm_promise, {
        js: {
            log: (level: any, ptr: any, len: any) => {
                const msg = decodeString(ptr, len);
                switch (level) {
                    case LOG_err:
                        console.error(msg);
                        if (domErrorsText) domErrorsText.textContent += msg + "\n";
                        if (domErrors) domErrors.classList.remove("hidden");
                        break;
                    case LOG_warn:
                        console.warn(msg);
                        break;
                    case LOG_info:
                        console.info(msg);
                        break;
                    case LOG_debug:
                        console.debug(msg);
                        break;
                }
            },
        },
    }).then((obj) => {
        wasm_exports = obj.instance.exports;
        if (typeof window !== "undefined") window.wasm = obj; // for debugging

        sources_promise.then((buffer) => {
            const js_array = new Uint8Array(buffer);
            const ptr = wasm_exports.alloc(js_array.length);
            const wasm_array = new Uint8Array(wasm_exports.memory.buffer, ptr, js_array.length);
            wasm_array.set(js_array);
            wasm_exports.unpack(ptr, js_array.length);

            updateModuleList();

            if (typeof window !== "undefined") {
                window.addEventListener("popstate", onPopState, false);
                window.addEventListener("keydown", onWindowKeyDown, false);
            }
            if (domSearch) {
                domSearch.addEventListener("keydown", onSearchKeyDown, false);
                domSearch.addEventListener("input", onSearchChange, false);
            }
            onHashChange(null);
        });
    });
}

function renderTitle() {
    if (typeof document === "undefined") return;
    const suffix = " - Zig Documentation";
    if (curNavSearch.length > 0) {
        document.title = curNavSearch + " - Search" + suffix;
    } else if (curNav.decl != null) {
        document.title = fullyQualifiedName(curNav.decl) + suffix;
    } else if (curNav.path != null) {
        document.title = curNav.path + suffix;
    } else {
        document.title = moduleList[0] + suffix;
    }
}

function render() {
    renderTitle();
    if (domContent) domContent.textContent = "";

    if (curNavSearch !== "") return renderSearch();

    switch (curNav.tag) {
        case 0:
            return renderHome();
        case 1:
            if (curNav.decl == null) {
                return renderNotFound();
            } else {
                return renderDecl(curNav.decl);
            }
        case 2:
            return renderSource(curNav.path);
        default:
            throw new Error("invalid navigation state");
    }
}

function renderHome() {
    if (moduleList.length == 0) {
        if (domContent) domContent.textContent = "# Error\n\nsources.tar contains no modules";
        return;
    }
    return renderModule(0);
}

function renderModule(pkg_index: any) {
    const root_decl = wasm_exports.find_module_root(pkg_index);
    return renderDecl(root_decl);
}

function renderDecl(decl_index: any) {
    let current = decl_index;
    const seen = new Set<number>();
    while (true) {
        const category = wasm_exports.categorize_decl(current, 0);
        switch (category) {
            case CAT_namespace:
            case CAT_container:
                return renderNamespacePage(current);
            case CAT_global_variable:
            case CAT_primitive:
            case CAT_global_const:
            case CAT_type:
            case CAT_type_type:
                return renderGlobal(current);
            case CAT_function:
                return renderFunction(current);
            case CAT_type_function:
                return renderTypeFunction(current);
            case CAT_error_set:
                return renderErrorSetPage(current);
            case CAT_alias: {
                if (seen.has(current)) return renderNotFound();
                seen.add(current);
                const aliasee = wasm_exports.get_aliasee();
                if (aliasee === -1) return renderNotFound();
                current = aliasee;
                continue;
            }
            default:
                throw new Error("unrecognized category " + category);
        }
    }
}

function renderSource(path: any) {
    const decl_index = findFileRoot(path);
    if (decl_index == null) return renderNotFound();

    let markdown = "";
    markdown += "# " + path + "\n\n";
    markdown += unwrapString(wasm_exports.decl_source_html(decl_index));

    if (domContent) domContent.textContent = markdown;
    return markdown;
}

function renderNamespacePage(decl_index: any) {
    let markdown = "";

    // Add title
    const name = unwrapString(wasm_exports.decl_category_name(decl_index));
    markdown += "# " + name + "\n\n";

    // Add documentation
    const docs = unwrapString(wasm_exports.decl_docs_html(decl_index, false));
    if (docs.length > 0) {
        markdown += docs + "\n\n";
    }

    // Add namespace content
    const members = namespaceMembers(decl_index, false).slice();
    const fields = declFields(decl_index).slice();
    markdown += renderNamespaceMarkdown(decl_index, members, fields);

    if (domContent) domContent.textContent = markdown;
    return markdown;
}

function renderFunction(decl_index: any) {
    let markdown = "";

    // Add title
    const name = unwrapString(wasm_exports.decl_category_name(decl_index));
    markdown += "# " + name + "\n";

    // Add documentation
    const docs = unwrapString(wasm_exports.decl_docs_html(decl_index, false));
    if (docs.length > 0) {
        markdown += "\n" + docs;
    }

    // Add function prototype
    const proto = unwrapString(wasm_exports.decl_fn_proto_html(decl_index, false));
    if (proto.length > 0) {
        markdown += "\n\n## Function Signature\n\n" + proto;
    }

    // Add parameters
    const params = declParams(decl_index).slice();
    if (params.length > 0) {
        markdown += "\n\n## Parameters\n";
        for (let i = 0; i < params.length; i++) {
            const param_html = unwrapString(wasm_exports.decl_param_html(decl_index, params[i]));
            markdown += "\n" + param_html;
        }
    }

    // Add errors
    const errorSetNode = fnErrorSet(decl_index);
    if (errorSetNode != null) {
        const base_decl = wasm_exports.fn_error_set_decl(decl_index, errorSetNode);
        const errorList = errorSetNodeList(decl_index, errorSetNode);
        if (errorList != null && errorList.length > 0) {
            markdown += "\n\n## Errors\n";
            for (let i = 0; i < errorList.length; i++) {
                const error_html = unwrapString(wasm_exports.error_html(base_decl, errorList[i]));
                markdown += "\n" + error_html;
            }
        }
    }

    // Add doctest
    const doctest = unwrapString(wasm_exports.decl_doctest_html(decl_index));
    if (doctest.length > 0) {
        markdown += "\n\n## Example Usage\n\n" + doctest;
    }

    // Add source code
    const source = unwrapString(wasm_exports.decl_source_html(decl_index));
    if (source.length > 0) {
        markdown += "\n\n## Source Code\n\n" + source;
    }

    if (domContent) domContent.textContent = markdown;
    return markdown;
}

function renderGlobal(decl_index: any) {
    let markdown = "";

    // Add title
    const name = unwrapString(wasm_exports.decl_category_name(decl_index));
    markdown += "# " + name + "\n\n";

    // Add documentation
    const docs = unwrapString(wasm_exports.decl_docs_html(decl_index, true));
    if (docs.length > 0) {
        markdown += docs + "\n\n";
    }

    // Add source code
    const source = unwrapString(wasm_exports.decl_source_html(decl_index));
    if (source.length > 0) {
        markdown += "## Source Code\n\n" + source + "\n\n";
    }

    if (domContent) domContent.textContent = markdown;
    return markdown;
}

function renderTypeFunction(decl_index: any) {
    let markdown = "";

    // Add title
    const name = unwrapString(wasm_exports.decl_category_name(decl_index));
    markdown += "# " + name + "\n\n";

    // Add documentation
    const docs = unwrapString(wasm_exports.decl_docs_html(decl_index, false));
    if (docs.length > 0) {
        markdown += docs + "\n\n";
    }

    // Add parameters
    const params = declParams(decl_index).slice();
    if (params.length > 0) {
        markdown += "## Parameters\n\n";
        for (let i = 0; i < params.length; i++) {
            const param_html = unwrapString(wasm_exports.decl_param_html(decl_index, params[i]));
            markdown += param_html + "\n\n";
        }
    }

    // Add doctest
    const doctest = unwrapString(wasm_exports.decl_doctest_html(decl_index));
    if (doctest.length > 0) {
        markdown += "## Example Usage\n\n" + doctest + "\n\n";
    }

    // Add namespace content or source
    const members = unwrapSlice32(wasm_exports.type_fn_members(decl_index, false)).slice();
    const fields = unwrapSlice32(wasm_exports.type_fn_fields(decl_index)).slice();
    if (members.length !== 0 || fields.length !== 0) {
        markdown += renderNamespaceMarkdown(decl_index, members, fields);
    } else {
        const source = unwrapString(wasm_exports.decl_source_html(decl_index));
        if (source.length > 0) {
            markdown += "## Source Code\n\n" + source + "\n\n";
        }
    }

    if (domContent) domContent.textContent = markdown;
    return markdown;
}

function renderErrorSetPage(decl_index: any) {
    let markdown = "";

    // Add title
    const name = unwrapString(wasm_exports.decl_category_name(decl_index));
    markdown += "# " + name + "\n\n";

    // Add documentation
    const docs = unwrapString(wasm_exports.decl_docs_html(decl_index, false));
    if (docs.length > 0) {
        markdown += docs + "\n\n";
    }

    // Add errors
    const errorSetList = declErrorSet(decl_index).slice();
    if (errorSetList != null && errorSetList.length > 0) {
        markdown += "## Errors\n\n";
        for (let i = 0; i < errorSetList.length; i++) {
            const error_html = unwrapString(wasm_exports.error_html(decl_index, errorSetList[i]));
            markdown += error_html + "\n\n";
        }
    }

    if (domContent) domContent.textContent = markdown;
    return markdown;
}

function renderNavMarkdown(decl_index: any) {
    let markdown = "";
    const list = [];

    // Walk backwards through decl parents
    let decl_it = decl_index;
    while (decl_it != null) {
        list.push(declIndexName(decl_it));
        decl_it = declParent(decl_it);
    }

    // Walk backwards through file path segments
    if (decl_index != null) {
        const file_path = fullyQualifiedName(decl_index);
        const parts = file_path.split(".");
        parts.pop(); // skip last
        for (let i = parts.length - 1; i >= 0; i--) {
            if (parts[i]) {
                list.push(parts[i]);
            }
        }
    }

    list.reverse();

    if (list.length > 0) {
        markdown += "*Navigation: " + list.join(" > ") + "*\n\n";
    }

    return markdown;
}

function renderNamespaceMarkdown(base_decl: any, members: any, fields: any) {
    let markdown = "";

    const typesList = [];
    const namespacesList = [];
    const errSetsList = [];
    const fnsList = [];
    const varsList = [];
    const valsList = [];

    // Categorize members
    for (let i = 0; i < members.length; i++) {
        let member = members[i];
        const original = member;
        const seen = new Set<number>();
        while (true) {
            const member_category = wasm_exports.categorize_decl(member, 0);
            switch (member_category) {
                case CAT_namespace:
                    namespacesList.push({ original: original, member: member });
                    break;
                case CAT_container:
                    typesList.push({ original: original, member: member });
                    break;
                case CAT_global_variable:
                    varsList.push(member);
                    break;
                case CAT_function:
                    fnsList.push(member);
                    break;
                case CAT_type:
                case CAT_type_type:
                case CAT_type_function:
                    typesList.push({ original: original, member: member });
                    break;
                case CAT_error_set:
                    errSetsList.push({ original: original, member: member });
                    break;
                case CAT_global_const:
                case CAT_primitive:
                    valsList.push({ original: original, member: member });
                    break;
                case CAT_alias: {
                    if (seen.has(member)) {
                        valsList.push({ original: original, member: member });
                        break;
                    }
                    seen.add(member);
                    member = wasm_exports.get_aliasee();
                    continue;
                }
                default:
                    throw new Error("unknown category: " + member_category);
            }
            break;
        }
    }

    // Render each category
    if (typesList.length > 0) {
        markdown += "## Types\n\n";
        for (let i = 0; i < typesList.length; i++) {
            const name = declIndexName(typesList[i].original);
            markdown += "- " + name + "\n";
        }
        markdown += "\n";
    }

    if (namespacesList.length > 0) {
        markdown += "## Namespaces\n\n";
        for (let i = 0; i < namespacesList.length; i++) {
            const name = declIndexName(namespacesList[i].original);
            markdown += "- " + name + "\n";
        }
        markdown += "\n";
    }

    if (errSetsList.length > 0) {
        markdown += "## Error Sets\n\n";
        for (let i = 0; i < errSetsList.length; i++) {
            const name = declIndexName(errSetsList[i].original);
            markdown += "- " + name + "\n";
        }
        markdown += "\n";
    }

    if (fnsList.length > 0) {
        markdown += "## Functions\n\n";
        for (let i = 0; i < fnsList.length; i++) {
            const decl = fnsList[i];
            const name = declIndexName(decl);
            const proto = unwrapString(wasm_exports.decl_fn_proto_html(decl, true));
            const docs = unwrapString(wasm_exports.decl_docs_html(decl, true));

            markdown += "### " + name + "\n\n";
            if (proto.length > 0) {
                markdown += proto + "\n\n";
            }
            if (docs.length > 0) {
                markdown += docs + "\n\n";
            }
        }
    }

    if (fields.length > 0) {
        markdown += "## Fields\n\n";
        for (let i = 0; i < fields.length; i++) {
            const field_html = unwrapString(wasm_exports.decl_field_html(base_decl, fields[i]));
            markdown += field_html + "\n\n";
        }
    }

    if (varsList.length > 0) {
        markdown += "## Global Variables\n\n";
        for (let i = 0; i < varsList.length; i++) {
            const decl = varsList[i];
            const name = declIndexName(decl);
            const type_html = unwrapString(wasm_exports.decl_type_html(decl));
            const docs = unwrapString(wasm_exports.decl_docs_html(decl, true));

            markdown += "### " + name + "\n\n";
            if (type_html.length > 0) {
                markdown += "Type: " + type_html + "\n\n";
            }
            if (docs.length > 0) {
                markdown += docs + "\n\n";
            }
        }
    }

    if (valsList.length > 0) {
        markdown += "## Values\n\n";
        for (let i = 0; i < valsList.length; i++) {
            const original_decl = valsList[i].original;
            const decl = valsList[i].member;
            const name = declIndexName(original_decl);
            const type_html = unwrapString(wasm_exports.decl_type_html(decl));
            const docs = unwrapString(wasm_exports.decl_docs_html(decl, true));

            markdown += "### " + name + "\n\n";
            if (type_html.length > 0) {
                markdown += "Type: " + type_html + "\n\n";
            }
            if (docs.length > 0) {
                markdown += docs + "\n\n";
            }
        }
    }

    return markdown;
}

function renderNotFound() {
    const markdown = "# Error\n\nDeclaration not found.";
    if (domContent) domContent.textContent = markdown;
    return markdown;
}

function renderSearch() {
    const ignoreCase = curNavSearch.toLowerCase() === curNavSearch;
    const results = executeQuery(curNavSearch, ignoreCase);

    let markdown = "# Search Results\n\n";
    markdown += 'Query: "' + curNavSearch + '"\n\n';

    if (results.length > 0) {
        markdown += "Found " + results.length + " results:\n\n";
        for (let i = 0; i < results.length; i++) {
            const match = results[i];
            const full_name = fullyQualifiedName(match);
            markdown += "- " + full_name + "\n";
        }
    } else {
        markdown += "No results found.\n\nPress escape to exit search.";
    }

    if (domContent) domContent.textContent = markdown;
    return markdown;
}

// Event handlers and utility functions (unchanged from original)
function updateCurNav(location_hash: any) {
    curNav.tag = 0;
    curNav.decl = null;
    curNav.path = null;
    curNavSearch = "";

    if (location_hash.length > 1 && location_hash[0] === "#") {
        const query = location_hash.substring(1);
        const qpos = query.indexOf("?");
        let nonSearchPart;
        if (qpos === -1) {
            nonSearchPart = query;
        } else {
            nonSearchPart = query.substring(0, qpos);
            curNavSearch = decodeURIComponent(query.substring(qpos + 1));
        }

        if (nonSearchPart.length > 0) {
            const source_mode = nonSearchPart.startsWith("src/");
            if (source_mode) {
                curNav.tag = 2;
                curNav.path = nonSearchPart.substring(4);
            } else {
                curNav.tag = 1;
                curNav.decl = findDecl(nonSearchPart);
            }
        }
    }
}

function onHashChange(state: any) {
    if (typeof history !== "undefined") history.replaceState({}, "");
    if (typeof location !== "undefined") navigate(location.hash);
    if (state == null && typeof window !== "undefined") window.scrollTo({ top: 0 });
}

function onPopState(ev: any) {
    onHashChange(ev.state);
}

function navigate(location_hash: any) {
    updateCurNav(location_hash);
    if (domSearch && domSearch.value !== curNavSearch) {
        domSearch.value = curNavSearch;
    }
    render();
}

function onSearchKeyDown(ev: any) {
    switch (ev.code) {
        case "Enter":
            if (ev.shiftKey || ev.ctrlKey || ev.altKey) return;
            clearAsyncSearch();
            if (typeof location !== "undefined") location.hash = computeSearchHash();
            ev.preventDefault();
            ev.stopPropagation();
            return;
        case "Escape":
            if (ev.shiftKey || ev.ctrlKey || ev.altKey) return;
            if (domSearch) {
                domSearch.value = "";
                domSearch.blur();
            }
            ev.preventDefault();
            ev.stopPropagation();
            startSearch();
            return;
        default:
            ev.stopPropagation();
            return;
    }
}

function onSearchChange(ev: any) {
    startAsyncSearch();
}

function onWindowKeyDown(ev: any) {
    switch (ev.code) {
        case "KeyS":
            if (ev.shiftKey || ev.ctrlKey || ev.altKey) return;
            if (domSearch) {
                domSearch.focus();
                domSearch.select();
            }
            ev.preventDefault();
            ev.stopPropagation();
            startAsyncSearch();
            break;
    }
}

function clearAsyncSearch() {
    if (searchTimer != null) {
        clearTimeout(searchTimer);
        searchTimer = null;
    }
}

function startAsyncSearch() {
    clearAsyncSearch();
    searchTimer = setTimeout(startSearch, 10);
}

function computeSearchHash() {
    if (typeof location === "undefined" || !domSearch) return "";
    const oldWatHash = location.hash;
    const oldHash = oldWatHash.startsWith("#") ? oldWatHash : "#" + oldWatHash;
    const parts = oldHash.split("?");
    const newPart2 = domSearch.value === "" ? "" : "?" + domSearch.value;
    return parts[0] + newPart2;
}

function startSearch() {
    clearAsyncSearch();
    navigate(computeSearchHash());
}

function updateModuleList() {
    moduleList.length = 0;
    for (let i = 0; ; i += 1) {
        const name = unwrapString(wasm_exports.module_name(i));
        if (name.length == 0) break;
        moduleList.push(name);
    }
}

// Utility functions (unchanged from original)
function decodeString(ptr: any, len: any) {
    if (len === 0) return "";
    return text_decoder.decode(new Uint8Array(wasm_exports.memory.buffer, ptr, len));
}

function unwrapString(bigint: any) {
    const ptr = Number(bigint & 0xffffffffn);
    const len = Number(bigint >> 32n);
    return decodeString(ptr, len);
}

function fullyQualifiedName(decl_index: any) {
    return unwrapString(wasm_exports.decl_fqn(decl_index));
}

function declIndexName(decl_index: any) {
    return unwrapString(wasm_exports.decl_name(decl_index));
}

function setQueryString(s: any) {
    const jsArray = text_encoder.encode(s);
    const len = jsArray.length;
    const ptr = wasm_exports.query_begin(len);
    const wasmArray = new Uint8Array(wasm_exports.memory.buffer, ptr, len);
    wasmArray.set(jsArray);
}

function executeQuery(query_string: any, ignore_case: any) {
    setQueryString(query_string);
    const ptr = wasm_exports.query_exec(ignore_case);
    const head = new Uint32Array(wasm_exports.memory.buffer, ptr, 1);
    const len = head[0];
    return new Uint32Array(wasm_exports.memory.buffer, ptr + 4, len);
}

function namespaceMembers(decl_index: any, include_private: any) {
    return unwrapSlice32(wasm_exports.namespace_members(decl_index, include_private));
}

function declFields(decl_index: any) {
    return unwrapSlice32(wasm_exports.decl_fields(decl_index));
}

function declParams(decl_index: any) {
    return unwrapSlice32(wasm_exports.decl_params(decl_index));
}

function declErrorSet(decl_index: any) {
    return unwrapSlice64(wasm_exports.decl_error_set(decl_index));
}

function errorSetNodeList(base_decl: any, err_set_node: any) {
    return unwrapSlice64(wasm_exports.error_set_node_list(base_decl, err_set_node));
}

function unwrapSlice32(bigint: any) {
    const ptr = Number(bigint & 0xffffffffn);
    const len = Number(bigint >> 32n);
    if (len === 0) return [];
    return new Uint32Array(wasm_exports.memory.buffer, ptr, len);
}

function unwrapSlice64(bigint: any) {
    const ptr = Number(bigint & 0xffffffffn);
    const len = Number(bigint >> 32n);
    if (len === 0) return [];
    return new BigUint64Array(wasm_exports.memory.buffer, ptr, len);
}

function findDecl(fqn: any) {
    setInputString(fqn);
    const result = wasm_exports.find_decl();
    if (result === -1) return null;
    return result;
}

function findFileRoot(path: any) {
    setInputString(path);
    const result = wasm_exports.find_file_root();
    if (result === -1) return null;
    return result;
}

function declParent(decl_index: any) {
    const result = wasm_exports.decl_parent(decl_index);
    if (result === -1) return null;
    return result;
}

function fnErrorSet(decl_index: any) {
    const result = wasm_exports.fn_error_set(decl_index);
    if (result === 0) return null;
    return result;
}

function setInputString(s: any) {
    const jsArray = text_encoder.encode(s);
    const len = jsArray.length;
    const ptr = wasm_exports.set_input_string(len);
    const wasmArray = new Uint8Array(wasm_exports.memory.buffer, ptr, len);
    wasmArray.set(jsArray);
}

export async function searchStdLib(
    wasmPath: string,
    stdSources: Uint8Array<ArrayBuffer>,
    query: string,
    limit: number = 20,
): Promise<string> {
    const fs = await import("node:fs");
    const wasmBytes = fs.readFileSync(wasmPath);

    const wasmModule = await WebAssembly.instantiate(wasmBytes, {
        js: {
            log: (level: any, ptr: any, len: any) => {
                const msg = decodeString(ptr, len);
                if (level === LOG_err) {
                    throw new Error(msg);
                }
            },
        },
    });

    const exports = wasmModule.instance.exports as any;
    wasm_exports = exports;

    const ptr = exports.alloc(stdSources.length);
    const wasmArray = new Uint8Array(exports.memory.buffer, ptr, stdSources.length);
    wasmArray.set(stdSources);
    exports.unpack(ptr, stdSources.length);

    const ignoreCase = query.toLowerCase() === query;
    const results = executeQuery(query, ignoreCase);

    let markdown = `# Search Results\n\nQuery: "${query}"\n\n`;

    if (results.length > 0) {
        const limitedResults = results.slice(0, limit);
        markdown += `Found ${results.length} results (showing ${limitedResults.length}):\n\n`;
        for (let i = 0; i < limitedResults.length; i++) {
            const match = limitedResults[i];
            const full_name = fullyQualifiedName(match);
            markdown += `- ${full_name}\n`;
        }
    } else {
        markdown += "No results found.";
    }

    return markdown;
}

export async function getStdLibItem(
    wasmPath: string,
    stdSources: Uint8Array<ArrayBuffer>,
    name: string,
    getSourceFile: boolean = false,
): Promise<string> {
    const fs = await import("node:fs");
    const wasmBytes = fs.readFileSync(wasmPath);

    const wasmModule = await WebAssembly.instantiate(wasmBytes, {
        js: {
            log: (level: any, ptr: any, len: any) => {
                const msg = decodeString(ptr, len);
                if (level === LOG_err) {
                    throw new Error(msg);
                }
            },
        },
    });

    const exports = wasmModule.instance.exports as any;
    wasm_exports = exports;

    const ptr = exports.alloc(stdSources.length);
    const wasmArray = new Uint8Array(exports.memory.buffer, ptr, stdSources.length);
    wasmArray.set(stdSources);
    exports.unpack(ptr, stdSources.length);

    const decl_index = findDecl(name);
    if (decl_index === null) {
        return `# Error\n\nDeclaration "${name}" not found.`;
    }

    if (getSourceFile) {
        // Resolve aliases by decl index
        let cur = decl_index;
        const seen = new Set<number>();
        while (true) {
            const cat = exports.categorize_decl(cur, 0);
            if (cat !== CAT_alias) break;
            if (seen.has(cur)) break; // cycle guard
            seen.add(cur);
            const next = exports.get_aliasee();
            if (next === -1 || next === cur) break;
            cur = next;
        }

        const filePath = unwrapString(wasm_exports.decl_file_path(cur));
        if (filePath && filePath.length > 0) {
            const fileDecl = findFileRoot(filePath);
            if (fileDecl !== null) {
                let markdown = "";
                markdown += "# " + filePath + "\n\n";
                markdown += unwrapString(wasm_exports.decl_source_html(fileDecl));
                return markdown;
            }
        }
        return `# Error\n\nCould not find source file for "${name}".`;
    }

    return renderDecl(decl_index);
}
