import * as vscode from 'vscode';
import extend = require('extend');
// import { performance } from 'perf_hooks';

// look at this number of lines at the top/bottom of the file
const NUM_LINES_TO_SEARCH = 5;
// don't try to find modelines on lines longer than this
const MAX_LINE_LENGTH = 500;

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.commands.registerCommand('modelines.apply', () => {
		applyModelines(vscode.window.activeTextEditor);
	}));

	// Listen for new documents being opened
	context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc => {
		// apparently the window.visibleTextEditors array is not up to date at this point,
		// so we have to work around that by waiting a bit.
		let tryApplyModelines = ():boolean => {
			let editor = vscode.window.visibleTextEditors.find(e => e.document === doc);
			if (editor) {
				applyModelines(editor);
				return true;
			}
			return false;
		};

		setTimeout(() => {
			if (!tryApplyModelines()) {
				// if it's still not available, try one more time after 500ms
				setTimeout(() => {
					if (!tryApplyModelines())
						console.log('[modelines] could not find TextEditor')
				}, 500);
			}
		}, 100);
	}));

	// Listen for saves and change settings if necessary
	context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(doc => {
		let editor = vscode.window.visibleTextEditors.find(e => e.document === doc);
		if (editor)
			applyModelines(editor);
	}));

	setImmediate(() => applyModelines(vscode.window.activeTextEditor));
}

export class ModelineSearcher {
	private document: vscode.TextDocument;

	constructor(doc: vscode.TextDocument) {
		this.document = doc;
	}

	public getModelineOptions(): any {
        // let searchLines = this.getLinesToSearch();
        let searchLines = this.getLinesToSearch_byLine();
		return extend({},
			this.getVimModelineOptions(searchLines),
			this.getEmacsModelineOptions(searchLines),
			this.getVSCodeModelineOptions(searchLines));
	}

	private getVSCodeModelineOptions(searchLines:string[]): any {
		let codeModelineRegex = /.{0,8}code:(.*)/;
		let codeModelineOptsRegex = /(\w+)=([^\s]+)/g;

		let parseOption = (name:string, value:string):any => {
			let parsedVal = this._parseGenericValue(value);
			switch (name.toLowerCase()) {
				case 'insertspaces':
					return { insertSpaces: parsedVal };
				case 'tabsize':
					return { tabSize: parsedVal };
				case 'language':
				case 'lang':
					return { language: parsedVal };
				default:
					return {};
			}
		};

		let options = {};
		searchLines.forEach(line => {
			let match = line.match(codeModelineRegex);
			if (match) {
				let opts = match[1];
				while (match = codeModelineOptsRegex.exec(opts))
					extend(options, parseOption(match[1], match[2]));
			}
		});
		return options;
	}

	private getVimModelineOptions(searchLines:string[]): any {
		let codeModelineRegex = /.{0,8}vim:(.*)/;
		let codeModelineOptsRegex = /(\w+)=([^:\s]+)|(\w+)/g;

		let parseOption = (name:string, value:string):any => {
			let parsedVal = this._parseGenericValue(value);
			switch (name) {
				case 'expandtab': case 'et':
					return { insertSpaces: true };
				case 'noexpandtab': case 'noet':
					return { insertSpaces: false };
				case 'tabstop': case 'ts':
				case 'softtabstop': case 'sts':
				case 'shiftwidth': case 'sw':
					return { tabSize: parsedVal };
				case 'filetype': case 'ft':
					return { language: parsedVal };
				default:
					return {};
			}
		};

		let options = {};
		searchLines.forEach(line => {
			let match = line.match(codeModelineRegex);
			if (match) {
				let opts = match[1];
				while (match = codeModelineOptsRegex.exec(opts))
					extend(options, parseOption(match[1] || match[3], match[2]));
			}
		});

		return options;
	}

	private getEmacsModelineOptions(searchLines:string[]): any {
		let emacsModelineRegex = /.{0,8}-\*-\s*(.*)-\*-/;
		let emacsModelineOptRegex = /([\w-]+):\s*([^;\s]*)|^(\w+)\s*$/g;

		let parseOption = (name:string, value:string):any => {
			// if there is no value then this was a modeline that looked like -*- C -*-
			// this is shorthand for mode:C
			if (!value)
				return { language: name.trim().toLowerCase() };

			let parsedVal = this._parseGenericValue(value);
			switch (name.toLowerCase()) {
				case 'indent-tabs-mode':
					return { insertSpaces: parsedVal == 'nil' };
				case 'tab-width':
					return { tabSize: parsedVal };
				case 'mode':
                    return { language: parsedVal };
                case 'st-word_wrap':
                case 'vc-word-wrap':
                case 'vs-word-wrap':
                    return { wordWrap: parsedVal };
                default:
					return {};
			}
		};

		let options = {};
		searchLines.forEach(line => {
			let match = line.match(emacsModelineRegex);
			if (match) {
				let opts = match[1];
				while (match = emacsModelineOptRegex.exec(opts))
					extend(options, parseOption(match[1] || match[3], match[2]));
			}
		});

		return options;
	}

	// private getLinesToSearch(): string[] {
    //     // ToDO: change to use .lineCount() and .lineAt() to gather lines, reducing work; check timing differences by doing both and logging the times
    //     let t0 = performance.now();
	// 	let lines = this.document.getText().split(/\n/g);
	// 	let checkNumLines = NUM_LINES_TO_SEARCH;
	// 	// avoid checking same line multiple times if file doesn't have enough lines
	// 	if (lines.length < NUM_LINES_TO_SEARCH*2)
	// 		checkNumLines = lines.length / 2;
	// 	let topLines = lines.slice(0, checkNumLines),
	// 		bottomLines = lines.slice(-checkNumLines);
    //     let retval = topLines.concat(bottomLines).filter(line => line.length <= MAX_LINE_LENGTH);
    //     let t1 = performance.now();
    //     console.log("getLinesToSearch duration = "+( t1 - t0)+" ms");
    //     return retval;
	// }

	private getLinesToSearch_byLine(): string[] {
        // reduces work; relatively constant time, even as files get larger (~50us)
        // let t0 = performance.now();
        let lineCount = this.document.lineCount;
        let lines:string[] = [];
        let lineList:number[] = [];
        if ( lineCount < 1 ) { return lines; }
        if ( lineCount < (NUM_LINES_TO_SEARCH * 2)) {
            lineList = [ ...Array(lineCount-1).keys() ];
        } else {
            lineList = [ ...Array(5).keys() ].concat([ ...Array(5).keys() ].map( n => (n + lineCount - NUM_LINES_TO_SEARCH - 1)))
        }
        lines = lineList.map( n => this.document.lineAt(n).text ).filter(line => line.length <= MAX_LINE_LENGTH);
        // let t1 = performance.now();
        // console.log("getLinesToSearch_byLine duration = "+( t1 - t0 )+" ms");
        return lines;
	}

	private _parseGenericValue(value:string): any {
		if (typeof value != 'string') return value;
		value = value.trim();
		if (/^(true|false)$/i.test(value)) {
			return value.toLowerCase() == 'true';
		} else if (/^[0-9]+$/.test(value)) {
			return parseInt(value, 10);
		}
		return value.replace(/['"]/g, '');
	}
}

export function applyModelines(editor: vscode.TextEditor|undefined): void {
	if (!editor || !editor.document || editor.document.isUntitled)
		return;
	try {
		let searcher = new ModelineSearcher(editor.document);
		let options = searcher.getModelineOptions();
		console.log('[modelines] setting editor options: ' + JSON.stringify(options));
		let language = translateLanguageName(options.language);
		if (options.language)
			delete options.language;

		extend(editor.options, options);
		// assignment is necessary to trigger the change
		editor.options = editor.options;

		if (language && language.length > 0) {
			vscode.languages.getLanguages().then(codelangs => {
				let codelang = codelangs.find(codelang => codelang.toLowerCase() === language.toLowerCase());
				if (codelang) {
					console.log('[modelines] setting language to '+codelang);
					vscode.languages.setTextDocumentLanguage(editor.document, codelang);
				}
			});
		}
	} catch (err) {
		console.error(err);
	}
}

function translateLanguageName(lang: string|undefined): string {
	if (lang === undefined)
		return '';
	switch (lang.toLowerCase()) {
		case 'js':
			return 'javascript';
		case 'c++':
			return 'cpp';
		case 'c#':
			return 'csharp';
		case 'f#':
			return 'fsharp';
		case 'objective-c++':
			return 'objective-cpp';
		case 'sh':
		case 'zsh':
		case 'ksh':
		case 'csh':
		case 'bash':
			return 'shellscript';
		default:
			return lang;
	}
}
