var TurndownService = (function () {
  'use strict';

  function extend (to, from) {
    for (var key in from) {
      to[key] = from[key];
    }
    return to
  }

  function repeat (character, count) {
    return Array(count + 1).join(character)
  }

  var blockElements = [
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'CANVAS', 'DD', 'DIV',
    'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1',
    'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HGROUP', 'HR', 'LI', 'MAIN', 'NAV',
    'NOSCRIPT', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TFOOT', 'UL', 'VIDEO'
  ];

  function isBlock (node) {
    return is(node, blockElements)
  }

  var voidElements = [
    'AREA', 'BASE', 'BR', 'COL', 'COMMAND', 'EMBED', 'HR', 'IMG', 'INPUT',
    'KEYGEN', 'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR'
  ];

  function isVoid (node) {
    return is(node, voidElements)
  }

  function hasVoid (node) {
    return has(node, voidElements)
  }

  var voidSelector = voidElements.join();
  function has (node, names) {
    return (
      node.getElementsByTagName &&
      names.some(function (name) {
        return node.getElementsByTagName(name).length
      })
    )
  }

  function is (node, override) {
    var reg = new RegExp('^(' + (override || blockElements).join('|') + ')$', 'i');
    return node && node.nodeName && reg.test(node.nodeName)
  }

  function clean (node) {
    var child = node.firstChild;
    while (child) {
      var next = child.nextSibling;
      if (child.nodeType === 3) {
        var text = child.nodeValue;
        if (!/\S/.test(text)) {
          node.removeChild(child);
        }
      } else if (child.nodeType === 1) {
        clean(child);
      }
      child = next;
    }
  }

  function Node (node) {
    this.node = node;
  }

  Node.prototype.isBlock = function () {
    return isBlock(this.node)
  };

  Node.prototype.isCode = function () {
    return this.node.nodeName === 'CODE' || this.node.parentNode.nodeName === 'CODE'
  };

  Node.prototype.isBlank = function () {
    return (
      !isVoid(this.node) &&
      !this.isCode() &&
      !hasVoid(this.node) &&
      /^\s*$/.test(this.node.textContent)
    )
  };

  function RootNode (input) {
    var root;
    if (typeof input === 'string') {
      var doc = new DOMParser().parseFromString(
        '<x-turndown id="turndown-root">' + input + '</x-turndown>',
        'text/html'
      );
      root = doc.getElementById('turndown-root');
    } else {
      root = input.cloneNode(true);
    }
    clean(root);
    return root
  }

  function TurndownService (options) {
    if (!(this instanceof TurndownService)) return new TurndownService(options)
    var defaults = {
      rules: rules,
      headingStyle: 'atx',
      hr: '* * *',
      bulletListMarker: '*',
      codeBlockStyle: 'indented',
      fence: '```',
      emDelimiter: '_',
      strongDelimiter: '**',
      linkStyle: 'inlined',
      linkReferenceStyle: 'full'
    };

    this.options = extend(defaults, options);
    this.rules = new Rules(this.options);
  }

  TurndownService.prototype.turndown = function (input) {
    if (!canParse(input)) {
      throw new TypeError(input + ' is not a string, or an element/document node.')
    }
    if (input === '') return ''

    var output = process.call(this, new RootNode(input));
    return postProcess(output)
  };

  function canParse (input) {
    return (
      typeof input === 'string' ||
      (input && input.nodeType && (input.nodeType === 1 || input.nodeType === 9 || input.nodeType === 11))
    )
  }

  function process (parentNode) {
    var self = this;
    return Array.prototype.reduce.call(parentNode.childNodes, function (output, node) {
      node = new Node(node);
      var replacement = '';
      if (node.node.nodeType === 3) {
        replacement = node.node.nodeValue.replace(/\n\s*/g, ' ');
      } else if (node.node.nodeType === 1) {
        if (node.isBlank()) {
          replacement = '';
        } else {
          var rule = self.rules.forNode(node.node);
          var content = process.call(self, node.node);
          replacement = rule.replacement(content, node.node, self.options);
        }
      }
      return join(output, replacement)
    }, '')
  }

  function postProcess (output) {
    return output.replace(/^[\t \r\n]+/, '').replace(/[\t \r\n]+$/, '').replace(/\n\s*\n\s*\n+/g, '\n\n')
  }

  function join (string1, string2) {
    var separator = '';
    if (string1 && string2) {
      if (/\n$/.test(string1) || /^\n/.test(string2)) separator = '';
      else separator = '\n\n';
    }
    return string1 + separator + string2
  }

  function Rules (options) {
    this.options = options;
    this._keep = [];
    this._remove = [];
    this.blankRule = {
      replacement: function (content, node) {
        return isBlock(node) ? '\n\n' : ''
      }
    };
    this.keepReplacement = function (content, node) {
      return isBlock(node) ? '\n\n' + node.outerHTML + '\n\n' : node.outerHTML
    };
    this.defaultRule = {
      replacement: function (content, node) {
        return isBlock(node) ? '\n\n' + content + '\n\n' : content
      }
    };
    this.array = [];
    for (var key in options.rules) {
      this.array.push(options.rules[key]);
    }
  }

  Rules.prototype.forNode = function (node) {
    if (node.isBlank) return this.blankRule
    var rule;
    if ((rule = findRule(this.array, node, this.options))) return rule
    return this.defaultRule
  };

  function findRule (rules, node, options) {
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      if (filterValue(rule, node, options)) return rule
    }
  }

  function filterValue (rule, node, options) {
    var filter = rule.filter;
    if (typeof filter === 'string') {
      if (filter === node.nodeName.toLowerCase()) return true
    } else if (Array.isArray(filter)) {
      if (filter.indexOf(node.nodeName.toLowerCase()) > -1) return true
    } else if (typeof filter === 'function') {
      return filter.call(rule, node, options)
    } else {
      throw new TypeError('filter must be a string, array, or function')
    }
  }

  var rules = {};

  rules.heading = {
    filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    replacement: function (content, node, options) {
      var hLevel = Number(node.nodeName.charAt(1));
      if (options.headingStyle === 'atx') {
        return '\n\n' + repeat('#', hLevel) + ' ' + content + '\n\n'
      } else {
        return '\n\n' + content + '\n' + repeat(hLevel === 1 ? '=' : '-', content.length) + '\n\n'
      }
    }
  };

  rules.paragraph = {
    filter: 'p',
    replacement: function (content) {
      return '\n\n' + content + '\n\n'
    }
  };

  rules.lineBreak = {
    filter: 'br',
    replacement: function (content, node, options) {
      return '  \n'
    }
  };

  rules.listItem = {
    filter: 'li',
    replacement: function (content, node, options) {
      content = content.replace(/^\n+/, '').replace(/\n+$/, '\n').replace(/\n/g, '\n  ');
      var prefix = options.bulletListMarker + ' ';
      var parent = node.parentNode;
      if (parent.nodeName === 'OL') {
        var start = parent.getAttribute('start');
        var index = Array.prototype.indexOf.call(parent.children, node);
        prefix = (start ? Number(start) + index : index + 1) + '. ';
      }
      return prefix + content + (node.nextSibling && !/\n$/.test(content) ? '\n' : '')
    }
  };

  rules.indentedCodeBlock = {
    filter: function (node, options) {
      return (
        options.codeBlockStyle === 'indented' &&
        node.nodeName === 'PRE' &&
        node.firstChild &&
        node.firstChild.nodeName === 'CODE'
      )
    },
    replacement: function (content, node) {
      return '\n\n    ' + node.firstChild.textContent.replace(/\n/g, '\n    ') + '\n\n'
    }
  };

  rules.fencedCodeBlock = {
    filter: function (node, options) {
      return (
        options.codeBlockStyle === 'fenced' &&
        node.nodeName === 'PRE' &&
        node.firstChild &&
        node.firstChild.nodeName === 'CODE'
      )
    },
    replacement: function (content, node, options) {
      var className = node.firstChild.className || '';
      var language = (className.match(/language-(\S+)/) || [null, ''])[1];
      var code = node.firstChild.textContent;
      var fence = options.fence;
      return '\n\n' + fence + language + '\n' + code + '\n' + fence + '\n\n'
    }
  };

  rules.link = {
    filter: function (node, options) {
      return (
        options.linkStyle === 'inlined' &&
        node.nodeName === 'A' &&
        node.getAttribute('href')
      )
    },
    replacement: function (content, node) {
      var href = node.getAttribute('href');
      var title = node.title ? ' "' + node.title + '"' : '';
      return '[' + content + '](' + href + title + ')'
    }
  };

  rules.emphasis = {
    filter: ['em', 'i'],
    replacement: function (content, node, options) {
      if (!content.trim()) return ''
      return options.emDelimiter + content + options.emDelimiter
    }
  };

  rules.strong = {
    filter: ['strong', 'b'],
    replacement: function (content, node, options) {
      if (!content.trim()) return ''
      return options.strongDelimiter + content + options.strongDelimiter
    }
  };

  return TurndownService;
}());
