/**
 * Papa Parse entry point. In Node this re-exports the npm package; in the browser
 * the server answers /shared/papa.js with an ES-module wrapper of the same package,
 * so parser.js has one import path in both places.
 */
import Papa from 'papaparse';
export default Papa;
