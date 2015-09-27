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
    var objectsToSort = findUnsortedObjects(lastOutput);
    output = replaceUnsortedObjects(lastOutput, objectsToSort);
    // keep iterating until all nested objects are sorted.
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

function findUnsortedObjects(input) {
  var ast = generateAST(input);
  var objectsToSort = [];

  walk.simple(ast, {
    ObjectExpression: function (node, state) {
      if (node.properties.length < 2) {
        return;
      }

      // Objects with function expressions are not sorted, they may be prototypes
      if (hasFunctionExpression(node.properties)) {
        return;
      }

      // properties are already sorted, no need to do anything.
      if (arePropertiesSorted(node.properties)) {
        return;
      }

      // A nested object node's range is invalid once it's ancestor
      // node is sorted. If the node has an ancestor that is already
      // being sorted, do NOT add this item to the stack. Additional
      // passes will take care of nested objects.
      if (isAncestorBeingSorted(node, state, objectsToSort)) {
        return;
      }

      // put on a stack and go in reverse order so that the node range
      // start and end are always correct. If forward order is used
      // while re-writing, the character ranges can change once
      // the initial object is updated.
      objectsToSort.push(node);
    }
  });

  return objectsToSort;
}

function arePropertiesSorted(properties) {
  var lastName;

  for (var i = 0; i < properties.length; ++i) {
    property = properties[i];
    var currName = (property.key.name || property.key.value).toLowerCase();

    if (lastName && lastName > currName) {
      return false;
    }

    lastName = currName;
  }

  return true;
}

function hasFunctionExpression(properties) {
  var functionExpressions = properties.filter(function (property) {
    return property.value.type === "FunctionExpression";
  });

  return !! functionExpressions.length;
}

function isAncestorBeingSorted(node, state, haystack) {
  var ancestorNodeIndex = -1;

  walk.ancestor(node, {
    ObjectExpression: function (ancestor) {
      // already have an index to insert before, abort.
      if (ancestorNodeIndex !== -1) {
        return;
      }

      var ancestorIndex = haystack.indexOf(ancestor);
      if (ancestorIndex !== -1) {
        ancestorNodeIndex = ancestorIndex;
      }
    }
  }, null, state);

  return ancestorNodeIndex !== -1;
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

function generateObjectReplacement(root) {
  var isOneLineObject = root.loc.start.line === root.loc.end.line;
  var indentStyle = isOneLineObject ? '' : '  ';
  var indentBase = isOneLineObject ? 0 : Math.floor(root.properties[0].key.loc.start.column / 2) - 1;

  var transformed = escodegen.generate(root, {
    comment: true,
    format: {
      indent: {
        base: indentBase,
        style: indentStyle
      }
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

function replaceUnsortedObjects(input, objectsToSort) {
  var output = input;
  while (objectsToSort.length) {
    var node = objectsToSort.pop();

    sortProperties(node.properties);

    var replacement = generateObjectReplacement(node);

    // eslint comments always start on the line before it.
    console.log('replacement', replacement);

    var before = output.slice(0, node.range[0]);
    var after = output.slice(node.range[1]);

    output = before + replacement + after;
  }

  return output;
}
