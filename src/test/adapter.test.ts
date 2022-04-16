import assert = require('assert');
import { expect } from 'chai';
import * as Path from 'path';
import { DebugClient } from 'vscode-debugadapter-testsupport/lib/main';
import { DebugProtocol } from 'vscode-debugprotocol/lib/debugProtocol';
import { LaunchRequestArguments, FsUAEDebugSession } from '../fsUAEDebug';
import * as Net from 'net';
import * as vscode from 'vscode';
import { GdbProxy } from '../gdbProxy';
import { GdbStackFrame, GdbStackPosition, GdbRegister, Segment, GdbHaltStatus, GdbThread, GdbAmigaSysThreadIdFsUAE } from '../gdbProxyCore';
import { spy, anyString, instance, when, anything, mock, anyNumber, reset, verify, resetCalls, capture } from '@johanblumenberg/ts-mockito';
import { ExecutorHelper } from '../execHelper';
import { Capstone } from '../capstone';
import { BreakpointManager, GdbBreakpoint, GdbBreakpointType } from '../breakpointManager';
import { DebugDisassembledFile } from '../debugDisassembled';
import { ExtensionState } from '../extension';

describe('Node Debug Adapter', () => {
	const PROJECT_ROOT = Path.join(__dirname, '..', '..').replace(/\\+/g, '/');
	const DEBUG_ADAPTER = Path.join(PROJECT_ROOT, 'out', 'debugAdapter.js').replace(/\\+/g, '/');
	const DATA_ROOT = Path.join(PROJECT_ROOT, 'test_files', 'debug').replace(/\\+/g, '/');
	const FSUAE_ROOT = Path.join(DATA_ROOT, 'fs-uae').replace(/\\+/g, '/');
	const UAE_DRIVE = Path.join(FSUAE_ROOT, 'hd0').replace(/\\+/g, '/');
	const SOURCE_FILE_NAME = Path.join(DATA_ROOT, 'gencop.s').replace(/\\+/g, '/');
	const launchArgs = <LaunchRequestArguments>{
		program: Path.join(UAE_DRIVE, 'hello'),
		stopOnEntry: false,
		serverName: 'localhost',
		serverPort: 6860,
		startEmulator: true,
		emulator: Path.join(FSUAE_ROOT, 'fs-uae'),
		options: [Path.join(FSUAE_ROOT, 'test.fs-uae')],
		drive: Path.join(FSUAE_ROOT, 'hd0'),
		sourceFileMap: {
			"C:\\Users\\paulr\\workspace\\amiga\\projects\\vscode-amiga-wks-example": DATA_ROOT
		}
	};
	let dc: DebugClient;
	const callbacks = new Map<string, any>();
	const testWithRealEmulator = false;
	const th = new GdbThread(0, GdbAmigaSysThreadIdFsUAE.CPU);
	const thCop = new GdbThread(1, GdbAmigaSysThreadIdFsUAE.COP);

	before(async function () {
		GdbThread.setSupportMultiprocess(false);
		// activate the extension
		const ext = vscode.extensions.getExtension('prb28.amiga-assembly');
		if (ext) {
			await ext.activate();
			await ExtensionState.getCurrent().getLanguage();
		}
	});


	beforeEach(async function () {
		this.mockedExecutor = mock(ExecutorHelper);
		this.executor = instance(this.mockedExecutor);
		this.mockedGdbProxy = mock(GdbProxy);
		this.mockedCapstone = mock(Capstone);
		this.capstone = instance(this.mockedCapstone);
		when(this.mockedGdbProxy.on(anyString(), anything())).thenCall(async (event: string, callback: (() => void)) => {
			callbacks.set(event, callback);
		});
		when(this.mockedGdbProxy.waitConnected()).thenResolve();
		this.gdbProxy = instance(this.mockedGdbProxy);
		when(this.mockedExecutor.runTool(anything(), anything(), anything(), anything(), anything(), anything(), anything(), anything(), anything())).thenReturn(Promise.resolve([]));
		// start port listener on launch of first debug this.session
		// start listening on a random port
		return new Promise<void>((resolve) => {
			this.server = Net.createServer(socket => {
				this.session = new FsUAEDebugSession();
				this.spiedSession = spy(this.session);
				when(this.spiedSession.checkEmulator(anything())).thenReturn(true);
				when(this.spiedSession.updateDisassembledView(anything(), anything())).thenResolve();
				if (!testWithRealEmulator) {
					this.session.setTestContext(this.gdbProxy, this.executor, this.capstone);
				}
				this.session.setRunAsServer(true);
				this.session.start(<NodeJS.ReadableStream>socket, socket);
				resolve();
			}).listen(0);
			// make VS Code connect to debug server instead of launching debug adapter
			dc = new DebugClient('node', DEBUG_ADAPTER, 'fs-uae');
			const address: any = this.server.address();
			let port = 0;
			if (address instanceof Object) {
				port = address.port;
			}
			dc.start(port).then(() => { resolve() });
		});
	});

	afterEach(async function () {
		if (this.spiedSession) {
			reset(this.spiedSession);
		}
		if (this.mockedExecutor) {
			reset(this.mockedExecutor);
		}
		if (this.mockedGdbProxy) {
			reset(this.mockedGdbProxy);
		}
		if (dc) {
			await dc.stop();
		}
		if (this.session) {
			this.session.shutdown();
		}
		if (this.server) {
			this.server.close();
		}
	});

	describe('basic', function () {
		it('unknown request should produce error', async function () {
			try {
				await dc.send('illegal_request');
				throw (new Error("does not report error on unknown request"));
			} catch (err) {
				//expected
			}
		});
	});

	describe('initialize', () => {
		it('should return supported features', function () {
			return dc.initializeRequest().then(function (response) {
				response.body = response.body || {};
				assert.strictEqual(response.body.supportsConfigurationDoneRequest, false);
				assert.strictEqual(response.body.supportsEvaluateForHovers, true);
				assert.strictEqual(response.body.supportsStepBack, false);
				assert.strictEqual(response.body.supportsRestartFrame, false);
				assert.strictEqual(response.body.supportsConditionalBreakpoints, false);
				assert.strictEqual(response.body.supportsSetVariable, true);
			});
		});

		it('should produce error for invalid \'pathFormat\'', function (done) {
			dc.initializeRequest({
				adapterID: 'mock',
				linesStartAt1: true,
				columnsStartAt1: true,
				pathFormat: 'url'
			}).then(function () {
				done(new Error("does not report error on invalid 'pathFormat' attribute"));
			}).catch(function () {
				// error expected
				done();
			});
		});
	});

	describe('launch', () => {
		beforeEach(function () {
			if (!testWithRealEmulator) {
				when(this.mockedGdbProxy.connect(anyString(), anyNumber())).thenReturn(Promise.resolve());
			}
		});

		it('should run program to the end', function () {
			if (!testWithRealEmulator) {
				when(this.mockedGdbProxy.load(anything(), anything())).thenCall(() => {
					const cb = callbacks.get('end');
					if (cb) {
						cb();
					}
					return Promise.resolve();
				});
			}
			return Promise.all([
				dc.configurationSequence(),
				dc.launch(launchArgs),
				dc.waitForEvent('terminated')
			]);
		});
		it('should stop on entry', function () {
			if (!testWithRealEmulator) {
				when(this.spiedSession.startEmulator(anything())).thenReturn(Promise.resolve()); // Do nothing
				when(this.mockedGdbProxy.load(anything(), anything())).thenCall(() => {
					setTimeout(function () {
						const cb = callbacks.get('stopOnEntry');
						if (cb) {
							cb(th.getId());
						}
					}, 1);
					return Promise.resolve();
				});
				when(this.mockedGdbProxy.stack(th)).thenReturn(Promise.resolve(<GdbStackFrame>{
					frames: [<GdbStackPosition>{
						index: 1,
						segmentId: 0,
						offset: 0,
						pc: 0,
						stackFrameIndex: 0
					}],
					count: 1
				}));
				when(this.mockedGdbProxy.getThread(th.getId())).thenReturn(th);
				when(this.mockedGdbProxy.getThreadIds()).thenReturn(Promise.resolve([th]));
			}
			const launchArgsCopy = launchArgs;
			launchArgsCopy.program = Path.join(UAE_DRIVE, 'gencop');
			launchArgsCopy.stopOnEntry = true;
			return Promise.all([
				dc.configurationSequence(),
				dc.launch(launchArgsCopy),
				dc.assertStoppedLocation('entry', { line: 32 })
			]);
		});
	});

	describe('setBreakpoints', function () {
		beforeEach(function () {
			if (!testWithRealEmulator) {
				when(this.mockedGdbProxy.connect(anything(), anything())).thenReturn(Promise.resolve());
				when(this.mockedGdbProxy.isConnected()).thenReturn(true);
				when(this.spiedSession.startEmulator(anything())).thenReturn(Promise.resolve()); // Do nothing
			}
		});
		it('should stop on a breakpoint', async function () {
			when(this.mockedGdbProxy.getThread(th.getId())).thenReturn(th);
			when(this.mockedGdbProxy.getThreadIds()).thenReturn(Promise.resolve([th]));
			when(this.mockedGdbProxy.load(anything(), anything())).thenCall(() => {
				setTimeout(function () {
					const cb = callbacks.get('stopOnBreakpoint');
					if (cb) {
						cb(th.getId());
					}
				}, 1);
				return Promise.resolve();
			});
			when(this.mockedGdbProxy.setBreakpoint(anything())).thenCall((bp: GdbBreakpoint) => {
				return new Promise<void>((resolve) => {
					bp.verified = true;
					const cb = callbacks.get('breakpointValidated');
					if (cb) {
						cb(bp);
					}
					resolve();
				});
			});
			when(this.mockedGdbProxy.stack(th)).thenReturn(Promise.resolve(<GdbStackFrame>{
				frames: [<GdbStackPosition>{
					index: 1,
					segmentId: 0,
					offset: 4,
					pc: 10,
					stackFrameIndex: 0
				}],
				count: 1
			}));
			when(this.mockedGdbProxy.registers(anything())).thenReturn(Promise.resolve([<GdbRegister>{
				name: "d0",
				value: 1
			}]));
			const launchArgsCopy = launchArgs;
			launchArgsCopy.program = Path.join(UAE_DRIVE, 'gencop');
			await Promise.all([
				dc.configurationSequence(),
				dc.launch(launchArgsCopy)
			]);
			return dc.hitBreakpoint(launchArgsCopy, { path: SOURCE_FILE_NAME, line: 33 });
		});

		it('hitting a lazy breakpoint should send a breakpoint event', async function () {
			when(this.mockedGdbProxy.getThread(th.getId())).thenReturn(th);
			when(this.mockedGdbProxy.getThreadIds()).thenReturn(Promise.resolve([th]));
			when(this.mockedGdbProxy.load(anything(), anything())).thenCall(() => {
				setTimeout(function () {
					const cb = callbacks.get('stopOnBreakpoint');
					if (cb) {
						cb(th.getId());
					}
				}, 1);
				setTimeout(function () {
					const cb = callbacks.get('breakpointValidated');
					if (cb) {
						cb(<GdbBreakpoint>{
							id: 0,
							segmentId: 0,
							offset: 0,
							verified: true,
						});
					}
				}, 2);
				return Promise.resolve();
			});
			when(this.mockedGdbProxy.setBreakpoint(anything())).thenCall((bp: GdbBreakpoint) => {
				return new Promise<void>((resolve) => {
					bp.verified = true;
					const cb = callbacks.get('breakpointValidated');
					if (cb) {
						cb(bp);
					}
					resolve();
				});
			});
			when(this.mockedGdbProxy.stack(th)).thenReturn(Promise.resolve(<GdbStackFrame>{
				frames: [<GdbStackPosition>{
					index: 1,
					segmentId: 0,
					offset: 4,
					pc: 10,
					stackFrameIndex: 0
				}],
				count: 1
			}));
			const launchArgsCopy = launchArgs;
			launchArgsCopy.program = Path.join(UAE_DRIVE, 'gencop');
			await Promise.all([
				dc.configurationSequence(),
				dc.launch(launchArgsCopy)
			]);
			return Promise.all([
				dc.hitBreakpoint(launchArgsCopy, { path: SOURCE_FILE_NAME, line: 33 }),
				dc.waitForEvent('breakpoint').then(function (event: DebugProtocol.Event) {
					assert.strictEqual(event.body.breakpoint.verified, true, "event mismatch: verified");
				})
			]);
		});
	});

	describe('stepping', function () {
		beforeEach(function () {
			if (!testWithRealEmulator) {
				when(this.mockedGdbProxy.getThread(th.getId())).thenReturn(th);
				when(this.mockedGdbProxy.getThreadIds()).thenReturn(Promise.resolve([th]));
				when(this.mockedGdbProxy.connect(anyString(), anyNumber())).thenReturn(Promise.resolve());
				when(this.spiedSession.startEmulator(anything())).thenReturn(Promise.resolve()); // Do nothing
				when(this.mockedGdbProxy.load(anything(), anything())).thenCall(() => {
					setTimeout(function () {
						const cb = callbacks.get('stopOnEntry');
						if (cb) {
							cb(th.getId());
						}
					}, 1);
					return Promise.resolve();
				});
			}
		});
		it('should step', async function () {
			if (!testWithRealEmulator) {
				when(this.mockedGdbProxy.stack(th)).thenReturn(Promise.resolve(<GdbStackFrame>{
					frames: [<GdbStackPosition>{
						index: 1,
						segmentId: 0,
						offset: 0,
						pc: 0,
						stackFrameIndex: 0
					}],
					count: 1
				})).thenReturn(Promise.resolve(<GdbStackFrame>{
					frames: [<GdbStackPosition>{
						index: 1,
						segmentId: 0,
						offset: 4,
						pc: 4,
						stackFrameIndex: 0
					}],
					count: 1
				})).thenReturn(Promise.resolve(<GdbStackFrame>{
					frames: [<GdbStackPosition>{
						index: 1,
						segmentId: 0,
						offset: 8,
						pc: 8,
						stackFrameIndex: 0
					}],
					count: 1
				}));
				when(this.mockedGdbProxy.stepToRange(th, 0, 0)).thenCall(() => {
					setTimeout(function () {
						const cb = callbacks.get('stopOnBreakpoint');
						if (cb) {
							cb(th.getId());
						}
					}, 1);
					return Promise.resolve();
				});
				when(this.mockedGdbProxy.stepIn(th)).thenCall(() => {
					setTimeout(function () {
						const cb = callbacks.get('stopOnBreakpoint');
						if (cb) {
							cb(th.getId());
						}
					}, 1);
					return Promise.resolve();
				});
			}
			const launchArgsCopy = launchArgs;
			launchArgsCopy.program = Path.join(UAE_DRIVE, 'gencop');
			launchArgsCopy.stopOnEntry = true;
			await Promise.all([
				dc.configurationSequence(),
				dc.launch(launchArgsCopy),
				dc.assertStoppedLocation('entry', { line: 32 })
			]);
			await Promise.all([
				dc.nextRequest(<DebugProtocol.StepInArguments>{ threadId: th.getId() }),
				dc.assertStoppedLocation('breakpoint', { line: 33 }),
			]);
			return Promise.all([
				dc.stepInRequest(<DebugProtocol.StepInArguments>{ threadId: th.getId() }),
				dc.assertStoppedLocation('breakpoint', { line: 37 }),
			]);
		});
		it('should continue and stop', async function () {
			if (!testWithRealEmulator) {
				when(this.mockedGdbProxy.stack(th)).thenReturn(Promise.resolve(<GdbStackFrame>{
					frames: [<GdbStackPosition>{
						index: 1,
						segmentId: 0,
						offset: 0,
						pc: 0,
						stackFrameIndex: 0
					}],
					count: 1
				})).thenReturn(Promise.resolve(<GdbStackFrame>{
					frames: [<GdbStackPosition>{
						index: 1,
						segmentId: 0,
						offset: 4,
						pc: 4,
						stackFrameIndex: 0
					}],
					count: 1
				}));
				when(this.mockedGdbProxy.continueExecution(th)).thenCall(() => {
					return Promise.resolve();
				});
				when(this.mockedGdbProxy.pause(th)).thenCall(() => {
					setTimeout(function () {
						const cb = callbacks.get('stopOnBreakpoint');
						if (cb) {
							cb(th.getId());
						}
					}, 1);
					return Promise.resolve();
				});
			}
			const launchArgsCopy = launchArgs;
			launchArgsCopy.program = Path.join(UAE_DRIVE, 'gencop');
			launchArgsCopy.stopOnEntry = true;
			await Promise.all([
				dc.configurationSequence(),
				dc.launch(launchArgsCopy),
				dc.assertStoppedLocation('entry', { line: 32 })
			]);
			await Promise.all([
				dc.continueRequest(<DebugProtocol.ContinueArguments>{ threadId: th.getId() }),
				dc.pauseRequest(<DebugProtocol.PauseArguments>{ threadId: th.getId() }),
				dc.assertStoppedLocation('breakpoint', { line: 33 }),
			]);
		});
	});
	describe('stack frame index', function () {
		beforeEach(function () {
			if (!testWithRealEmulator) {
				when(this.mockedGdbProxy.getThread(th.getId())).thenReturn(th);
				when(this.mockedGdbProxy.getThreadIds()).thenReturn(Promise.resolve([th]));
				when(this.mockedGdbProxy.connect(anyString(), anyNumber())).thenReturn(Promise.resolve());
				when(this.spiedSession.startEmulator(anything())).thenReturn(Promise.resolve()); // Do nothing
				when(this.mockedCapstone.disassemble(anyString())).thenReturn(Promise.resolve(" 0  90 91  sub.l\t(a1), d0\n"));
				when(this.mockedGdbProxy.load(anything(), anything())).thenCall(() => {
					setTimeout(function () {
						let cb = callbacks.get('stopOnEntry');
						if (cb) {
							cb(th.getId());
						}
						cb = callbacks.get('segmentsUpdated');
						if (cb) {
							cb([<Segment>{ id: 0, address: 10, size: 416 }]);
						}
					}, 1);
					return Promise.resolve();
				});
				when(this.mockedGdbProxy.getRegister(anyString(), anything())).thenReturn(new Promise((resolve) => { resolve(["0", -1]); })).thenReturn(new Promise((resolve, _reject) => { resolve(["a", 1]); }));
				when(this.mockedGdbProxy.getMemory(10, anyNumber())).thenReturn(Promise.resolve("0000000000c00b0000f8"));
				when(this.mockedGdbProxy.registers(anything(), anything())).thenReturn(Promise.resolve([<GdbRegister>{
					name: "d0",
					value: 1
				}, <GdbRegister>{
					name: "a0",
					value: 10
				}]));
				when(this.mockedGdbProxy.getSegments()).thenReturn([<Segment>{ id: 0, address: 10, size: 10 }]);
				when(this.mockedGdbProxy.toRelativeOffset(anyNumber())).thenReturn([-1, 40]);
			}
		});
		it('should retrieve a complex stack', async function () {
			if (!testWithRealEmulator) {
				when(this.mockedGdbProxy.stack(th)).thenReturn(Promise.resolve(<GdbStackFrame>{
					frames: [<GdbStackPosition>{
						index: -1,
						segmentId: 0,
						offset: 0,
						pc: 0,
						stackFrameIndex: 1
					}, <GdbStackPosition>{
						index: 1,
						segmentId: -1,
						offset: 0,
						pc: 10,
						stackFrameIndex: 0
					}],
					count: 2
				}));
				when(this.mockedGdbProxy.registers(anything(), anything())).thenReturn(Promise.resolve([<GdbRegister>{
					name: "d0",
					value: 1
				}, <GdbRegister>{
					name: "a0",
					value: 10
				}, <GdbRegister>{
					name: "sr",
					value: 0b1000000000000000
				}, <GdbRegister>{
					name: "SR_T1",
					value: 1
				}, <GdbRegister>{
					name: "SR_T0",
					value: 0
				}]));

			}
			when(this.mockedGdbProxy.isCPUThread(anything())).thenReturn(true);
			const launchArgsCopy = launchArgs;
			launchArgsCopy.program = Path.join(UAE_DRIVE, 'gencop');
			launchArgsCopy.stopOnEntry = true;
			await Promise.all([
				dc.configurationSequence(),
				dc.launch(launchArgsCopy),
				dc.assertStoppedLocation('entry', { line: 32 })
			]);
			const response: DebugProtocol.StackTraceResponse = await dc.stackTraceRequest(<DebugProtocol.StackTraceArguments>{ threadId: th.getId() });
			expect(response.success).to.be.equal(true);
			expect(response.body.totalFrames).to.be.equal(2);
			const stackFrames = response.body.stackFrames;
			expect(stackFrames[0].id).to.be.equal(-1);
			expect(stackFrames[0].line).to.be.equal(32);
			expect(stackFrames[0].name).to.be.equal("$0: move.l 4.w,a6");
			const src = stackFrames[0].source;
			// tslint:disable-next-line: no-unused-expression
			expect(src).to.not.be.undefined;
			if (src) {
				// tslint:disable-next-line:no-unused-expression
				expect(src.name).not.to.be.undefined;
				if (src.name) {
					expect(src.name.toUpperCase()).to.be.equal("GENCOP.S");
				}
				if (src.path) {
					const pathToTest = Path.join("test_files", "debug", "gencop.s").replace(/\\+/g, '/');
					expect(src.path.toUpperCase().endsWith(pathToTest.toUpperCase())).to.be.equal(true);
				}
			}
			expect(stackFrames[1].id).to.be.equal(1);
			expect(stackFrames[1].line).to.be.equal(0);
			expect(stackFrames[1].name).to.be.equal("$a: sub.l	(a1), d0");
			const responseScopes: DebugProtocol.ScopesResponse = await dc.scopesRequest(<DebugProtocol.ScopesArguments>{ frameId: 0 });
			expect(responseScopes.body.scopes[0].name).to.be.equal('Registers');
			expect(responseScopes.body.scopes[1].name).to.be.equal('Segments');
			expect(responseScopes.body.scopes[2].name).to.be.equal('Symbols');
			const vRegistersResponse = await dc.variablesRequest(<DebugProtocol.VariablesArguments>{ variablesReference: responseScopes.body.scopes[0].variablesReference });
			expect(vRegistersResponse.body.variables.length).to.be.equal(3);
			expect(vRegistersResponse.body.variables[0].name).to.be.equal("d0");
			expect(vRegistersResponse.body.variables[0].type).to.be.equal("register");
			expect(vRegistersResponse.body.variables[0].value).to.be.equal("0x00000001");
			expect(vRegistersResponse.body.variables[0].variablesReference).to.be.equal(0);
			expect(vRegistersResponse.body.variables[1].name).to.be.equal("a0");
			expect(vRegistersResponse.body.variables[2].name).to.be.equal("sr");
			expect(vRegistersResponse.body.variables[2].variablesReference).not.to.be.equal(0);
			//retrieve the sr values
			const vSRRegistersResponse = await dc.variablesRequest(<DebugProtocol.VariablesArguments>{ variablesReference: vRegistersResponse.body.variables[2].variablesReference });
			expect(vSRRegistersResponse.body.variables[0].name).to.be.equal("T1");
			expect(vSRRegistersResponse.body.variables[0].type).to.be.equal("register");
			expect(vSRRegistersResponse.body.variables[0].value).to.be.equal("1");
			expect(vSRRegistersResponse.body.variables[0].variablesReference).to.be.equal(0);
			expect(vSRRegistersResponse.body.variables[1].name).to.be.equal("T0");
			const vSegmentsResponse = await dc.variablesRequest(<DebugProtocol.VariablesArguments>{ variablesReference: responseScopes.body.scopes[1].variablesReference });
			expect(vSegmentsResponse.body.variables[0].name).to.be.equal("Segment #0");
			expect(vSegmentsResponse.body.variables[0].type).to.be.equal("segment");
			expect(vSegmentsResponse.body.variables[0].value).to.be.equal("0x0000000a {size:10}");
			expect(vSegmentsResponse.body.variables[0].variablesReference).to.be.equal(0);
			const vSymbolsResponse = await dc.variablesRequest(<DebugProtocol.VariablesArguments>{ variablesReference: responseScopes.body.scopes[2].variablesReference });
			expect(vSymbolsResponse.body.variables[0].name).to.be.equal("checkmouse");
			expect(vSymbolsResponse.body.variables[0].type).to.be.equal("symbol");
			expect(vSymbolsResponse.body.variables[0].value).to.be.equal("0x0000015c");
			expect(vSymbolsResponse.body.variables[0].variablesReference).to.be.equal(0);
		});
		it('should retrieve a copper stack', async function () {
			when(this.mockedGdbProxy.getMemory(22624, 10)).thenReturn(Promise.resolve("0180056c2c07fffe0180"));
			when(this.mockedGdbProxy.getMemory(14676096, 4)).thenReturn(Promise.resolve("5850"));
			when(this.mockedGdbProxy.getThread(thCop.getId())).thenReturn(thCop);
			when(this.mockedGdbProxy.getThreadIds()).thenReturn(Promise.resolve([th, thCop]));
			when(this.mockedGdbProxy.isCopperThread(anything())).thenReturn(true);
			if (!testWithRealEmulator) {
				when(this.mockedGdbProxy.stack(th)).thenReturn(Promise.resolve(<GdbStackFrame>{
					frames: [<GdbStackPosition>{
						index: -1,
						segmentId: 0,
						offset: 0,
						pc: 0,
						stackFrameIndex: 1
					}],
					count: 1
				}));
				when(this.mockedGdbProxy.stack(thCop)).thenReturn(Promise.resolve(<GdbStackFrame>{
					frames: [<GdbStackPosition>{
						index: -1,
						segmentId: 0,
						offset: 22624,
						pc: 22624,
						stackFrameIndex: 1
					}],
					count: 1
				}));
			}
			const launchArgsCopy = launchArgs;
			launchArgsCopy.program = Path.join(UAE_DRIVE, 'gencop');
			launchArgsCopy.stopOnEntry = true;
			await Promise.all([
				dc.configurationSequence(),
				dc.launch(launchArgsCopy),
				dc.assertStoppedLocation('entry', { line: 32 })
			]);
			const response: DebugProtocol.StackTraceResponse = await dc.stackTraceRequest(<DebugProtocol.StackTraceArguments>{ threadId: thCop.getId() });
			expect(response.success).to.be.equal(true);
			expect(response.body.totalFrames).to.be.equal(1);
			const stackFrames = response.body.stackFrames;
			expect(stackFrames[0].id).to.be.equal(-1);
			expect(stackFrames[0].line).to.be.equal(5);
			expect(stackFrames[0].name).to.be.equal("$5860: dc.w $0180,$056c");
			const src = stackFrames[0].source;
			// tslint:disable-next-line: no-unused-expression
			expect(src).to.not.be.undefined;
			if (src) {
				// tslint:disable-next-line:no-unused-expression
				expect(src.name).not.to.be.undefined;
				if (src.name) {
					expect(src.name).to.be.equal("copper_$5850__500.dbgasm");
				}
			}
		});
	});
	describe('evaluateExpression', function () {
		beforeEach(async function () {
			if (!testWithRealEmulator) {
				when(this.mockedGdbProxy.getThread(th.getId())).thenReturn(th);
				when(this.mockedGdbProxy.getThreadIds()).thenReturn(Promise.resolve([th]));
				when(this.mockedGdbProxy.connect(anyString(), anyNumber())).thenReturn(Promise.resolve());
				when(this.spiedSession.startEmulator(anything())).thenReturn(Promise.resolve()); // Do nothing
				when(this.mockedGdbProxy.load(anything(), anything())).thenCall(() => {
					setTimeout(function () {
						const cb = callbacks.get('stopOnEntry');
						if (cb) {
							cb(th.getId());
						}
					}, 1);
					this.session.updateSegments([<Segment>{
						id: 0,
						address: 10,
						size: 416
					}]);
					return Promise.resolve();
				});
				when(this.mockedGdbProxy.setBreakpoint(anything())).thenCall((segmentId: number, offset: number) => {
					return Promise.resolve(<GdbBreakpoint>{
						id: 0,
						segmentId: 0,
						offset: 0,
						verified: false,
					});
				});
				when(this.mockedGdbProxy.stack(th)).thenReturn(Promise.resolve(<GdbStackFrame>{
					frames: [<GdbStackPosition>{
						index: 1,
						segmentId: 0,
						offset: 4,
						pc: 10,
						stackFrameIndex: 0
					}],
					count: 1
				}));
				when(this.mockedGdbProxy.getRegister(anyString(), anything())).thenReturn(new Promise((resolve, reject) => { resolve(["a", -1]); }));
				when(this.mockedGdbProxy.registers(anything(), anything())).thenReturn(Promise.resolve([<GdbRegister>{
					name: "d0",
					value: 1
				}, <GdbRegister>{
					name: "a0",
					value: 10
				}]));
				when(this.mockedCapstone.disassemble(anyString())).thenReturn(Promise.resolve(" 0  90 91  sub.l\t(a1), d0\n"));
				when(this.mockedGdbProxy.setMemory(0, anyString())).thenReturn(Promise.resolve());
				when(this.mockedGdbProxy.setMemory(10, anyString())).thenReturn(Promise.resolve());
				when(this.mockedGdbProxy.setMemory(11, anyString())).thenReturn(Promise.resolve());
				when(this.mockedGdbProxy.getMemory(0, anyNumber())).thenReturn(Promise.resolve("0000000000c00b0000f8"));
				when(this.mockedGdbProxy.getMemory(10, anyNumber())).thenReturn(Promise.resolve("aa00000000c00b0000f8"));
				when(this.mockedGdbProxy.getMemory(422, anyNumber())).thenReturn(Promise.resolve("0000000b")); // 422 = 19c + 10
				when(this.mockedGdbProxy.getMemory(11, anyNumber())).thenReturn(Promise.resolve("bb00000000c00b0000f8"));
				when(this.mockedGdbProxy.getMemory(0xdff180, anyNumber())).thenReturn(Promise.resolve("1234"));
			}
			const launchArgsCopy = launchArgs;
			launchArgsCopy.program = Path.join(UAE_DRIVE, 'gencop');
			launchArgsCopy.stopOnEntry = true;
			await Promise.all([
				dc.configurationSequence(),
				dc.launch(launchArgsCopy),
				dc.assertStoppedLocation('entry', { line: 33 })
			]);
		});
		it('should evaluate a memory location', async function () {
			let evaluateResponse = await dc.evaluateRequest({
				expression: "m0,10"
			});
			expect(evaluateResponse.body.type).to.equal('array');
			expect(evaluateResponse.body.result).to.equal('00000000 00c00b00 00f8          | .....À...ø');
			// Test variable replacement
			evaluateResponse = await dc.evaluateRequest({
				expression: "m ${a0},10"
			});
			expect(evaluateResponse.body.result).to.equal('aa000000 00c00b00 00f8          | ª....À...ø');
			evaluateResponse = await dc.evaluateRequest({
				expression: "m ${copper_list},10"
			});
			expect(evaluateResponse.body.result).to.equal('0000000b                            | ....');
			evaluateResponse = await dc.evaluateRequest({
				expression: "m #{copper_list},10"
			});
			expect(evaluateResponse.body.result).to.equal('bb000000 00c00b00 00f8          | »....À...ø');
			evaluateResponse = await dc.evaluateRequest({
				expression: "m ${color00},1"
			});
			expect(evaluateResponse.body.result).to.equal('1234                            | .4');
		});
		it('should respond to a memory read', async function () {
			const args = <DebugProtocol.ReadMemoryArguments>{
				memoryReference: "0",
				count: 10
			};
			const readMemoryResponse = await dc.customRequest("readMemory", args);
			expect(readMemoryResponse.body.address).to.be.equal("0");
			expect(readMemoryResponse.body.data).to.be.equal("AAAAAADACwAA+A==");
		});
		it('should evaluate a set memory command', async function () {
			let evaluateResponse = await dc.evaluateRequest({
				expression: "M0=10"
			});
			verify(this.mockedGdbProxy.setMemory(0, anyString())).once();
			resetCalls(this.mockedGdbProxy);
			expect(evaluateResponse.body.type).to.equal('array');
			expect(evaluateResponse.body.result).to.equal('00000000 00c00b00 00f8          | .....À...ø');
			// Test variable replacement
			evaluateResponse = await dc.evaluateRequest({
				expression: "M${a0}=10"
			});
			verify(this.mockedGdbProxy.setMemory(10, anyString())).once();
			resetCalls(this.mockedGdbProxy);
			expect(evaluateResponse.body.result).to.equal('aa000000 00c00b00 00f8          | ª....À...ø');
			evaluateResponse = await dc.evaluateRequest({
				expression: "M #{copper_list}=10"
			});
			verify(this.mockedGdbProxy.setMemory(11, anyString())).once();
			resetCalls(this.mockedGdbProxy);
			expect(evaluateResponse.body.result).to.equal('bb000000 00c00b00 00f8          | »....À...ø');
		});
		it('should evaluate a memory disassemble', async function () {
			let evaluateResponse = await dc.evaluateRequest({
				expression: "m0,10,d"
			});
			expect(evaluateResponse.body.type).to.equal('array');
			expect(evaluateResponse.body.result).to.equal('sub.l (a1), d0');
			// Test variable replacement
			evaluateResponse = await dc.evaluateRequest({
				expression: "m ${pc},10,d"
			});
			expect(evaluateResponse.body.result).to.equal('sub.l (a1), d0');
			evaluateResponse = await dc.evaluateRequest({
				expression: "m ${copper_list},10,d"
			});
			expect(evaluateResponse.body.result).to.equal('sub.l (a1), d0');
		});
		context('Extension actions', function () {
			it('should disassemble memory in a view', async function () {
				const spiedWindow = spy(vscode.window);
				const promise = new Promise<string>((resolve, reject) => { resolve("${pc}"); });
				when(spiedWindow.showInputBox(anything())).thenReturn(promise);
				when(this.spiedSession.disassembleRequest(anything(), anything())).thenReturn(Promise.resolve()); // Do nothing
				await vscode.commands.executeCommand("amiga-assembly.disassemble-memory");
				verify(spiedWindow.showInputBox(anything())).once();
				const dFile = new DebugDisassembledFile();
				dFile.setStackFrameIndex(0);
				dFile.setAddressExpression("${pc}");
				dFile.setLength(1000);
				const [uri] = capture(spiedWindow.showTextDocument).last();
				expect(uri.path).to.be.eql(dFile.toURI().path);
			});
			it('should disassemble copper in a view', async function () {
				const spiedWindow = spy(vscode.window);
				const promise = new Promise<string>((resolve, reject) => { resolve("${copper}"); });
				when(spiedWindow.showInputBox(anything())).thenReturn(promise);
				when(this.spiedSession.disassembleRequest(anything(), anything())).thenReturn(Promise.resolve()); // Do nothing
				await vscode.commands.executeCommand("amiga-assembly.disassemble-copper");
				verify(spiedWindow.showInputBox(anything())).once();
				const dFile = new DebugDisassembledFile();
				dFile.setCopper(true);
				dFile.setAddressExpression("${copper}");
				dFile.setLength(3000);
				const [uri] = capture(spiedWindow.showTextDocument).last();
				expect(uri.path).to.be.eql(dFile.toURI().path);
			});
		});
	});
	describe('Set variables', function () {
		beforeEach(async function () {
			if (!testWithRealEmulator) {
				when(this.mockedGdbProxy.getThread(th.getId())).thenReturn(th);
				when(this.mockedGdbProxy.getThreadIds()).thenReturn(Promise.resolve([th]));
				when(this.mockedGdbProxy.connect(anyString(), anyNumber())).thenReturn(Promise.resolve());
				when(this.spiedSession.startEmulator(anything())).thenReturn(Promise.resolve()); // Do nothing
				when(this.mockedGdbProxy.load(anything(), anything())).thenCall(() => {
					setTimeout(function () {
						const cb = callbacks.get('stopOnEntry');
						if (cb) {
							cb(th.getId());
						}
					}, 1);
					this.session.updateSegments([<Segment>{
						id: 0,
						address: 10,
						size: 416
					}]);
					return Promise.resolve();
				});
				when(this.mockedGdbProxy.stack(th)).thenReturn(Promise.resolve(<GdbStackFrame>{
					frames: [<GdbStackPosition>{
						index: 1,
						segmentId: 0,
						offset: 4,
						pc: 10,
						stackFrameIndex: 0
					}],
					count: 1
				}));
				when(this.mockedGdbProxy.getRegister(anyString(), anything())).thenReturn(new Promise((resolve, reject) => { resolve(["a", -1]); }));
				when(this.mockedGdbProxy.registers(anything())).thenReturn(Promise.resolve([<GdbRegister>{
					name: "d0",
					value: 1
				}, <GdbRegister>{
					name: "a0",
					value: 10
				}]));
			}
			const launchArgsCopy = launchArgs;
			launchArgsCopy.program = Path.join(UAE_DRIVE, 'gencop');
			launchArgsCopy.stopOnEntry = true;
			await Promise.all([
				dc.configurationSequence(),
				dc.launch(launchArgsCopy),
				dc.assertStoppedLocation('entry', { line: 33 })
			]);
		});
		it('should set a variable value', async function () {
			const responseScopes: DebugProtocol.ScopesResponse = await dc.scopesRequest(<DebugProtocol.ScopesArguments>{ frameId: 0 });
			when(this.mockedGdbProxy.setRegister(anything(), anything())).thenReturn(Promise.resolve("af"));
			const response = await dc.setVariableRequest(<DebugProtocol.SetVariableArguments>{
				variablesReference: responseScopes.body.scopes[0].variablesReference
			});
			expect(response.body.value).to.be.equal("af");
		});
	});
	describe('setExceptionBreakpoints', function () {
		beforeEach(function () {
			if (!testWithRealEmulator) {
				when(this.mockedGdbProxy.getThread(th.getId())).thenReturn(th);
				when(this.mockedGdbProxy.getThreadIds()).thenReturn(Promise.resolve([th]));
				when(this.mockedGdbProxy.connect(anyString(), anyNumber())).thenReturn(Promise.resolve());
				when(this.spiedSession.startEmulator(anything())).thenReturn(Promise.resolve()); // Do nothing
			}
		});
		it('should stop on an exception', async function () {
			when(this.mockedGdbProxy.load(anything(), anything())).thenCall(() => {
				setTimeout(function () {
					const cb = callbacks.get('stopOnException');
					if (cb) {
						cb(<GdbHaltStatus>{
							code: 8,
							details: "details"
						}, th.getId());
					}
				}, 1);
				return Promise.resolve();
			});
			when(this.mockedGdbProxy.setBreakpoint(anything())).thenCall((brp: GdbBreakpoint) => {
				return new Promise<void>((resolve, reject) => {
					if (brp.exceptionMask === undefined) {
						brp.verified = true;
						const cb = callbacks.get('breakpointValidated');
						if (cb) {
							cb(brp);
						}
					}
					resolve();
				});
			});
			when(this.mockedGdbProxy.stack(th)).thenReturn(Promise.resolve(<GdbStackFrame>{
				frames: [<GdbStackPosition>{
					index: 1,
					segmentId: 0,
					offset: 4,
					pc: 10,
					stackFrameIndex: 0
				}],
				count: 1
			}));
			when(this.mockedGdbProxy.registers(anything())).thenReturn(Promise.resolve([<GdbRegister>{
				name: "d0",
				value: 1
			}]));
			when(this.mockedGdbProxy.getHaltStatus()).thenReturn(Promise.resolve(<GdbHaltStatus>{
				code: 8,
				details: "details"
			}));
			const launchArgsCopy = launchArgs;
			launchArgsCopy.program = Path.join(UAE_DRIVE, 'gencop');
			await Promise.all([
				dc.waitForEvent('initialized').then(function (event) {
					return dc.setExceptionBreakpointsRequest({
						filters: ['all']
					});
				}).then(function () {
					return dc.configurationDoneRequest();
				}),

				dc.launch(launchArgsCopy),

				dc.assertStoppedLocation('exception', { line: 33 })
			]);
			// Test Breakpoint removal
			when(this.mockedGdbProxy.removeBreakpoint(anything())).thenReturn(Promise.resolve());
			const response = await dc.setExceptionBreakpointsRequest(<DebugProtocol.SetExceptionBreakpointsArguments>{
				filters: []
			});
			expect(response.success).to.be.equal(true);
			const [bp] = capture(this.mockedGdbProxy.removeBreakpoint).last();
			expect(bp).to.be.eql(<GdbBreakpoint>{
				breakpointType: GdbBreakpointType.EXCEPTION,
				exceptionMask: BreakpointManager.DEFAULT_EXCEPTION_MASK,
				id: 1,
				verified: false
			});
		});
	});
});