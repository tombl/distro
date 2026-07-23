/* Stubs for panic=abort wasm: no unwinder exists; backtraces report nothing. */
typedef int _Unwind_Reason_Code;
_Unwind_Reason_Code _Unwind_Backtrace(_Unwind_Reason_Code (*fn)(void *, void *), void *arg) {
	(void)fn; (void)arg;
	return 5; /* _URC_END_OF_STACK */
}
unsigned long _Unwind_GetIP(void *ctx) {
	(void)ctx;
	return 0;
}
unsigned long _Unwind_GetCFA(void *ctx) {
	(void)ctx;
	return 0;
}
void *_Unwind_FindEnclosingFunction(void *pc) {
	(void)pc;
	return 0;
}
