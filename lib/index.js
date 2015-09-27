/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const acorn = require('acorn');
const commodore = require('commodore');
const escodegen = require('escodegen');
const esprima = require('esprima');
const fs = require('fs');
const path = require('path');
const walk = require('acorn/dist/walk');


commodore
  .version('0.0.0')
  .option('-i, --input <filename>', 'input file')
  .parse(process.argv);

const filename = commodore.input;

const root = path.dirname(filename) || process.cwd();
const inputFile = path.join(root, filename);
const input = fs.readFileSync(filename).toString();

var output = sortObjects(input);

var shouldWriteOutput = output !== input;
if (shouldWriteOutput) {
  console.log('writing file', filename);
  fs.writeFileSync(filename, output, 'utf8');
}


function sortObjects(input) {
  var lastOutput;
  var output = input;

  do {
    lastOutput = output;
    var ast = generateAST(lastOutput);
    var unsortedObjects = findUnsortedObjects(ast);
    output = replaceUnsortedObjects(lastOutput, unsortedObjects);
  } while (output !== lastOutput);

  return output;
}
function generateAST(input) {
  const comments = [];
  const tokens = [];
  const ast = acorn.parse(input, {
    ecmaVersion: 6,
    // we want line locations!
    locations: true,
    ranges: true,
    onComment: comments,
    onToken: tokens
  });
  escodegen.attachComments(ast, comments, tokens);
  return ast;
}

function findUnsortedObjects(ast) {
  var unsortedObjects = [];

  walk.simple(ast, {
    ObjectExpression: function (node, state) {
      if (node.properties.length < 2) {
        return;
      }

      var functionExpressions = node.properties.filter(function (property) {
        return property.value.type === "FunctionExpression";
      });

      // Objects with function expressions are not sorted, they may be prototypes
      if (functionExpressions.length) {
        return;
      }

      var unsortedProperties = node.properties;
      var sortedProperties = sortProperties([].concat(node.properties));

      for (var i = 0; i < unsortedProperties.length; ++i) {
        if (unsortedProperties[i] !== sortedProperties[i]) {
          // put on a stack and go in reverse order so that the node range
          // start and end are always correct. If forward order is used
          // while re-writing, the character ranges can change once
          // the initial object is updated.

          // check if ancestor is on the stack. If so, place object in stack
          // before ancestor so that its output is updated before the ancestor
          // and the character ranges are kept correct.

          var ancestorNodeIndex = -1;
          walk.ancestor(node, {
            ObjectExpression: function (ancestor) {
              // already have an index to insert before, abort.
              if (ancestorNodeIndex !== -1) {
                return;
              }

              var ancestorIndex = unsortedObjects.indexOf(ancestor);
              if (ancestorIndex !== -1) {
                ancestorNodeIndex = ancestorIndex;
              }
            }
          }, null, state);

          if (ancestorNodeIndex === -1) {
            unsortedObjects.push(node);
          } /*else {
            unsortedObjects.splice(ancestorNodeIndex, 0, node);
          }*/
          return;
        }
      }
    }
  });

  return unsortedObjects;
}

function sortProperties(properties) {
  properties.sort(function (a, b) {
    var aLower = (a.key.name || a.key.value).toLowerCase();
    var bLower = (b.key.name || b.key.value).toLowerCase();
    if (aLower > bLower) {
      return 1;
    } else if (aLower === bLower) {
      return 0;
    }
    return -1;
  });
  return properties;
}

function generateObjectReplacement(root, base) {
  var isOneLineObject = base === -1;
  var indentStyle = isOneLineObject ? '' : '  ';
  var indentBase = isOneLineObject ? 0 : base;
  var transformed = escodegen.generate(root, {
    comment: true,
    format: {
      indent: {
        base: indentBase,
        style: indentStyle
      },
      /*preserveBlankLines: true*/
    },
    sourceCode: input
  });

  // eslint comments are always on the same line as the key/value pair
  transformed = transformed.replace(/\s+\/\/eslint/g, ' //eslint');

  // if a one line object, replace all newlines with a space.
  if (isOneLineObject) {
    transformed = transformed.replace(/\n/g, ' ');
  }

  return transformed;
}

function replaceUnsortedObjects(input, unsortedObjects) {
  var output = input;
  while (unsortedObjects.length) {
    var node = unsortedObjects.pop();

    var isOneLineObject = node.loc.start.line === node.loc.end.line;

    // TODO, we should probably handle nested objects correctly.
    sortProperties(node.properties);

    var base = isOneLineObject ? -1 : Math.floor(node.properties[0].key.loc.start.column / 2) - 1;
    var replacement = generateObjectReplacement(node, base);

    // eslint comments always start on the line before it.
    console.log('replacement', replacement);

    var before = output.slice(0, node.range[0]);
    var after = output.slice(node.range[1]);

    output = before + replacement + after;
  }

  return output;
}


/*console.log(escodegen.generate(ast, { comment: true, format: { indent: { style: '  ' }}}));*/
