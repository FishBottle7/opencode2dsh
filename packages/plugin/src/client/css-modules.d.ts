/** CSS Modules type shim for the client bundle (tsdown compiles *.module.css).
 *  Declared with literal keys (not an index signature) so class references
 *  stay `string` under noUncheckedIndexedAccess. */
declare module '*.module.css' {
  const classes: { [key: string]: string & { } }
  export default classes
}
